"""
MetaPromptExtractor — Standalone ComfyUI Custom Node
=====================================================
Extracts positive and negative prompts from ComfyUI images and
JSON workflow files.  Supports loading files from **any folder on any disk**.

No external dependencies beyond standard ComfyUI (PIL, torch, numpy).
Does NOT require the Prompt Manager parent package.

Node name  : Meta Prompt Extractor
Category   : utils
Outputs    : positive_prompt (STRING), negative_prompt (STRING), image (IMAGE)
"""
import os
import sys
import json
import re
import io
import mimetypes

import folder_paths
import torch
import server

# PIL / numpy (standard in ComfyUI)
try:
    import numpy as np
    from PIL import Image
    from PIL.PngImagePlugin import PngInfo
    IMAGE_SUPPORT = True
except ImportError:
    IMAGE_SUPPORT = False
    print("[MetaPromptExtractor] Warning: PIL/numpy not available, image metadata reading disabled")

# ── In-memory caches ──────────────────────────────────────────────────────────
_file_metadata_cache = {}   # JS → Python metadata hand-off

TAG = "[MetaPromptExtractor]"

# Stub: always return False to extract all LoRAs without filtering
def is_lora_blacklisted(lora_name):
    """LoRA filtering disabled - extract all LoRAs"""
    return False


# ── A1111 → ComfyUI name mappings ─────────────────────────────────────────────
# A1111 uses human-readable names (e.g. "DPM++ 2M SDE"); ComfyUI uses
# k-diffusion internal names (e.g. "dpmpp_2m_sde").  Lookup is case-insensitive.
_A1111_SAMPLER_MAP = {
    "euler":                "euler",
    "euler a":              "euler_ancestral",
    "lms":                  "lms",
    "heun":                 "heun",
    "heun++":               "heunpp2",
    "dpm2":                 "dpm_2",
    "dpm2 a":               "dpm_2_ancestral",
    "dpm fast":             "dpm_fast",
    "dpm adaptive":         "dpm_adaptive",
    "dpm++ sde":            "dpmpp_sde",
    "dpm++ 2s a":           "dpmpp_2s_ancestral",
    "dpm++ 2m":             "dpmpp_2m",
    "dpm++ 2m sde":         "dpmpp_2m_sde",
    "dpm++ 2m sde heun":    "dpmpp_2m_sde",   # no exact ComfyUI equivalent
    "dpm++ 3m sde":         "dpmpp_3m_sde",
    "ddim":                 "ddim",
    "plms":                 "ipndm",           # closest equivalent
    "ddpm":                 "ddpm",
    "unipc":                "uni_pc",
    "uni_pc":               "uni_pc",
    "uni_pc_bh2":           "uni_pc_bh2",
    "lcm":                  "lcm",
    "deis":                 "deis",
}

_A1111_SCHEDULER_MAP = {
    "karras":               "karras",
    "exponential":          "exponential",
    "sgm uniform":          "sgm_uniform",
    "uniform":              "normal",
    "normal":               "normal",
    "simple":               "simple",
    "ddim":                 "ddim_uniform",
    "beta":                 "beta",
    "polyexponential":      "exponential",     # closest available
    "align your steps":     "normal",          # no ComfyUI equivalent
    "kl optimal":           "normal",          # no ComfyUI equivalent
    "automatic":            "normal",
}


def _map_a1111_sampler(name):
    """Convert an A1111 sampler name to its ComfyUI equivalent.
    Returns 'euler' if the mapped value isn't a valid ComfyUI sampler."""
    if not name:
        return 'euler'
    mapped = _A1111_SAMPLER_MAP.get(name.lower().strip(), name)
    _VALID_SAMPLERS = ['euler','euler_ancestral','heun','heunpp2','dpm_2','dpm_2_ancestral',
        'lms','dpm_fast','dpm_adaptive','dpmpp_2s_ancestral','dpmpp_sde','dpmpp_sde_gpu',
        'dpmpp_2m','dpmpp_2m_sde','dpmpp_2m_sde_gpu','dpmpp_3m_sde','dpmpp_3m_sde_gpu',
        'ddpm','lcm','ipndm','ipndm_v','deis','ddim','uni_pc','uni_pc_bh2']
    if mapped not in _VALID_SAMPLERS:
        return 'euler'
    return mapped


def _map_a1111_scheduler(name):
    """Convert an A1111 scheduler / schedule-type to its ComfyUI equivalent.
    Returns 'simple' if the mapped value isn't a valid ComfyUI scheduler."""
    if not name:
        return 'simple'
    mapped = _A1111_SCHEDULER_MAP.get(name.lower().strip(), name)
    _VALID_SCHEDULERS = ['normal','karras','exponential','sgm_uniform','simple','ddim_uniform',
        'beta','linear_quadratic','kl_optimal']
    if mapped not in _VALID_SCHEDULERS:
        return 'simple'
    return mapped


def parse_a1111_parameters(parameters_text):
    """
    Parse A1111/Forge parameters format
    Returns dict with prompt, negative_prompt, and loras
    """
    if not parameters_text:
        return None

    result = {
        'prompt': '',
        'negative_prompt': '',
        'loras': []
    }

    # Split by "Negative prompt:" to separate positive and negative
    parts = re.split(r'Negative prompt:\s*', parameters_text, flags=re.IGNORECASE)
    positive_prompt = parts[0].strip()
    remainder = parts[1] if len(parts) > 1 else ''

    # Extract LoRAs using pattern: <lora:name:strength> or <lora:name:model_strength:clip_strength>
    lora_pattern = r'<lora:([^:>]+):([^:>]+)(?::([^:>]+))?>'
    loras = []

    for match in re.finditer(lora_pattern, positive_prompt):
        lora_name = match.group(1).strip()
        strength1 = float(match.group(2))
        strength2 = float(match.group(3)) if match.group(3) else strength1

        loras.append({
            'name': lora_name,
            'model_strength': strength1,
            'clip_strength': strength2,
            'active': True
        })

    # Remove LoRA tags from prompt
    positive_prompt = re.sub(lora_pattern, '', positive_prompt).strip()
    result['prompt'] = positive_prompt
    result['loras'] = loras

    # Extract negative prompt (before any "Steps:" line if present)
    settings_match = re.match(r'^(.*?)[\r\n]+Steps:', remainder, re.DOTALL)
    if settings_match:
        result['negative_prompt'] = settings_match.group(1).strip()
    else:
        result['negative_prompt'] = remainder.strip()

    # Extract model name from settings line (e.g. "Model: modelName")
    model_match = re.search(r'\bModel:\s*([^,\n]+)', parameters_text)
    if model_match:
        result['model'] = model_match.group(1).strip()

    # ── Extract sampler / resolution / generation settings ────────────────
    # A1111 format: "Steps: 20, Sampler: DPM++ 2M SDE, Schedule type: Karras,
    #                CFG scale: 5, Seed: 2427658518, Size: 768x1152, ..."
    settings_line = ''
    steps_pos = parameters_text.find('Steps:')
    if steps_pos >= 0:
        settings_line = parameters_text[steps_pos:]

    if settings_line:
        def _a1111_val(key, text=settings_line):
            m = re.search(r'\b' + re.escape(key) + r':\s*([^,\n]+)', text)
            return m.group(1).strip() if m else None

        steps = _a1111_val('Steps')
        if steps:
            try:
                result['steps'] = int(steps)
            except ValueError:
                pass

        sampler = _a1111_val('Sampler')
        if sampler:
            result['sampler_name'] = _map_a1111_sampler(sampler)

        schedule = _a1111_val('Schedule type')
        if schedule:
            result['scheduler'] = _map_a1111_scheduler(schedule)

        cfg = _a1111_val('CFG scale')
        if cfg:
            try:
                result['cfg'] = float(cfg)
            except ValueError:
                pass

        seed = _a1111_val('Seed')
        if seed:
            try:
                result['seed'] = int(seed)
            except ValueError:
                pass

        size = _a1111_val('Size')
        if size:
            m = re.match(r'(\d+)\s*x\s*(\d+)', size)
            if m:
                result['width'] = int(m.group(1))
                result['height'] = int(m.group(2))

        # ── Extract Forge/A1111 Module fields ────────────────────────────
        # Forge embeds CLIP/VAE module names as "Module 1: ae, Module 2: clip_l, Module 3: t5xxl_fp16"
        # These are reliable family indicators when the model name is unrecognised.
        modules = []
        for i in range(1, 5):
            mod = _a1111_val(f'Module {i}')
            if mod:
                modules.append(mod.lower())
        if modules:
            result['modules'] = modules

    return result


def extract_metadata_from_png(file_path):
    """Extract workflow/prompt metadata from PNG file (cached from JavaScript)"""
    try:
        # Try to get relative path from input or output directory (matches JavaScript cache keys)
        input_dir = folder_paths.get_input_directory()
        output_dir = folder_paths.get_output_directory()
        use_cache = True
        if file_path.startswith(input_dir):
            cache_key = os.path.relpath(file_path, input_dir).replace('\\', '/')
        elif file_path.startswith(output_dir):
            cache_key = os.path.relpath(file_path, output_dir).replace('\\', '/')
            # Output files can be regenerated at the same relative path while JS
            # metadata cache still holds a previous run. Prefer fresh file-read.
            use_cache = False
        else:
            # For files outside input/output, use the full normalized path as key
            # (matches what JavaScript sends in cacheFileMetadata)
            cache_key = file_path.replace(os.sep, '/')
            use_cache = True  # Always check cache for external files

        # Check if metadata was cached by JavaScript
        if use_cache and cache_key in _file_metadata_cache:
            metadata = _file_metadata_cache[cache_key]
            print(f"[PromptExtractor] Using cached PNG metadata for: {cache_key}")

            if isinstance(metadata, dict):
                prompt_data = metadata.get('prompt')
                workflow_data = metadata.get('workflow')

                # Check if we have parsed A1111 parameters
                # Return both parsed parameters AND workflow data (workflow needed for JSON export)
                if metadata.get('parsed_parameters'):
                    print("[PromptExtractor] Found parsed A1111 parameters")
                    parsed = metadata['parsed_parameters']
                    # JS parser doesn't extract sampler/resolution/modules — enrich
                    # from the raw parameters text via the Python parser.
                    raw_params = metadata.get('parameters', '')
                    if raw_params:
                        py_parsed = parse_a1111_parameters(raw_params)
                        if py_parsed:
                            for k in ('steps', 'sampler_name', 'scheduler', 'cfg',
                                      'seed', 'width', 'height', 'modules'):
                                if k in py_parsed and k not in parsed:
                                    parsed[k] = py_parsed[k]
                    return parsed, workflow_data

                return prompt_data, workflow_data

        # Fallback to PIL if no cached data (backwards compatibility)
        if not IMAGE_SUPPORT:
            return None, None

        print(f"[PromptExtractor] Falling back to PIL for: {file_path}")
        with Image.open(file_path) as img:
            metadata = img.info

            # Debug: Print all metadata keys found
            print(f"[PromptExtractor] PNG metadata keys: {list(metadata.keys())}")

            # ComfyUI stores data in 'prompt' and 'workflow' text chunks
            prompt_data = metadata.get('prompt')
            workflow_data = metadata.get('workflow')

            # Also check for alternative key names (some tools use different names)
            if not prompt_data:
                prompt_data = metadata.get('Prompt') or metadata.get('parameters') or metadata.get('Comment')
            if not workflow_data:
                workflow_data = metadata.get('Workflow')

            # Debug: Show if we found anything
            print(f"[PromptExtractor] prompt_data found: {prompt_data is not None}, workflow_data found: {workflow_data is not None}")
            if prompt_data:
                print(f"[PromptExtractor] prompt_data preview: {str(prompt_data)[:200]}...")
            if workflow_data:
                print(f"[PromptExtractor] workflow_data preview: {str(workflow_data)[:200]}...")

            # Parse JSON if present
            prompt_json = None
            workflow_json = None

            if prompt_data:
                try:
                    prompt_json = json.loads(prompt_data) if isinstance(prompt_data, str) else prompt_data
                except json.JSONDecodeError as e:
                    print(f"[PromptExtractor] Failed to parse prompt JSON: {e}")
                    # Check if it's A1111 parameters format
                    if isinstance(prompt_data, str) and ('Negative prompt:' in prompt_data or '<lora:' in prompt_data):
                        print("[PromptExtractor] Detected A1111 parameters format, parsing...")
                        parsed = parse_a1111_parameters(prompt_data)
                        if parsed:
                            prompt_json = parsed
                            print(f"[PromptExtractor] Parsed {len(parsed.get('loras', []))} LoRAs from A1111 parameters")
                    else:
                        # Plain text prompt (fallback)
                        prompt_json = {'positive': prompt_data}

            if workflow_data:
                try:
                    workflow_json = json.loads(workflow_data) if isinstance(workflow_data, str) else workflow_data
                except json.JSONDecodeError as e:
                    print(f"[PromptExtractor] Failed to parse workflow JSON: {e}")

            return prompt_json, workflow_json
    except Exception as e:
        print(f"[PromptExtractor] Error reading PNG metadata: {e}")
        import traceback
        traceback.print_exc()
        return None, None


def extract_metadata_from_jpeg(file_path):
    """Extract workflow/prompt metadata from JPEG/WebP file (cached from JavaScript)"""
    try:
        # Try to get relative path from input or output directory (matches JavaScript cache keys)
        input_dir = folder_paths.get_input_directory()
        output_dir = folder_paths.get_output_directory()
        if file_path.startswith(input_dir):
            cache_key = os.path.relpath(file_path, input_dir).replace('\\', '/')
        elif file_path.startswith(output_dir):
            cache_key = os.path.relpath(file_path, output_dir).replace('\\', '/')
        else:
            # For files outside input/output, use the full normalized path as key
            cache_key = file_path.replace(os.sep, '/')

        # Check if metadata was cached by JavaScript
        if cache_key in _file_metadata_cache:
            metadata = _file_metadata_cache[cache_key]
            print(f"[PromptExtractor] Using cached JPEG/WebP metadata for: {cache_key}")

            if isinstance(metadata, dict):
                # Check for prompt/workflow structure
                if 'prompt' in metadata and 'workflow' in metadata:
                    return metadata.get('prompt'), metadata.get('workflow')
                elif 'workflow' in metadata:
                    return None, metadata.get('workflow')
                else:
                    return metadata, None
        else:
            print(f"[PromptExtractor] No cached metadata found for JPEG/WebP: {file_path}")
            print("[PromptExtractor] Note: Image metadata is read by JavaScript when file is selected")

        # Fallback to PIL if no cached data (backwards compatibility)
        if not IMAGE_SUPPORT:
            return None, None

        print(f"[PromptExtractor] Falling back to PIL for: {file_path}")
        with Image.open(file_path) as img:
            # Try EXIF data
            exif = img.getexif()
            if exif:
                prompt_data = None
                workflow_data = None

                # ComfyUI stores metadata in EXIF tags:
                # 0x010e (ImageDescription): "Workflow: {json}"
                # 0x010f (Make): "Prompt: {json}"
                for tag_id in (0x010e, 0x010f):
                    tag_val = exif.get(tag_id)
                    if tag_val:
                        if isinstance(tag_val, bytes):
                            tag_val = tag_val.decode('utf-8', errors='ignore')
                        tag_val = tag_val.strip().rstrip('\x00')
                        if tag_val.startswith('Workflow:'):
                            json_str = tag_val[len('Workflow:'):].strip()
                            try:
                                workflow_data = json.loads(json_str)
                            except:
                                pass
                        elif tag_val.startswith('Prompt:'):
                            json_str = tag_val[len('Prompt:'):].strip()
                            try:
                                prompt_data = json.loads(json_str)
                            except:
                                pass

                if prompt_data or workflow_data:
                    return prompt_data, workflow_data

                # Fallback: UserComment field (0x9286) - used by some tools
                user_comment = exif.get(0x9286)
                if user_comment:
                    # Try to parse as JSON
                    try:
                        if isinstance(user_comment, bytes):
                            user_comment = user_comment.decode('utf-8', errors='ignore')
                        # Remove potential UNICODE prefix
                        if user_comment.startswith('UNICODE'):
                            user_comment = user_comment[7:].lstrip('\x00')
                        data = json.loads(user_comment)
                        return data.get('prompt'), data.get('workflow')
                    except:
                        pass

            # Try ImageDescription
            if hasattr(img, 'info'):
                for key in ['prompt', 'workflow', 'parameters', 'Comment']:
                    if key in img.info:
                        try:
                            data = json.loads(img.info[key])
                            if isinstance(data, dict):
                                return data, None
                        except:
                            pass

            return None, None
    except Exception as e:
        print(f"[PromptExtractor] Error reading JPEG/WebP metadata: {e}")
        return None, None


def extract_metadata_from_json(file_path):
    """Extract workflow data from JSON file (cached from JavaScript)"""
    try:
        # Try to get relative path from input or output directory (matches JavaScript cache keys)
        input_dir = folder_paths.get_input_directory()
        output_dir = folder_paths.get_output_directory()
        if file_path.startswith(input_dir):
            cache_key = os.path.relpath(file_path, input_dir).replace('\\', '/').replace('\\', '/')
        elif file_path.startswith(output_dir):
            cache_key = os.path.relpath(file_path, output_dir).replace('\\', '/').replace('\\', '/')
        else:
            # For files outside input/output, use the full normalized path as key
            cache_key = file_path.replace(os.sep, '/')

        # Check if metadata was cached by JavaScript
        if cache_key in _file_metadata_cache:
            data = _file_metadata_cache[cache_key]
            print(f"[PromptExtractor] Using cached JSON metadata for: {cache_key}")
        else:
            print(f"[PromptExtractor] No cached metadata found for JSON: {cache_key}")
            print("[PromptExtractor] Falling back to file read")
            # Fallback to reading file (backwards compatibility)
            with open(file_path, 'r', encoding='utf-8') as f:
                data = json.load(f)

        print(f"[PromptExtractor] JSON loaded, type: {type(data)}, keys: {list(data.keys()) if isinstance(data, dict) else 'N/A'}")

        # Check if it's a workflow format (has nodes) or prompt format
        if isinstance(data, dict):
            # API format (prompt) - node_id: {class_type, inputs}
            if any(isinstance(v, dict) and 'class_type' in v for v in data.values()):
                print("[PromptExtractor] JSON detected as API/prompt format")
                return data, None
            # Workflow format - has 'nodes' array
            if 'nodes' in data:
                print(f"[PromptExtractor] JSON detected as workflow format with {len(data.get('nodes', []))} nodes")
                return None, data
            # Could be wrapped
            if 'prompt' in data:
                print("[PromptExtractor] JSON detected as wrapped format")
                return data.get('prompt'), data.get('workflow')

        print("[PromptExtractor] JSON format not recognized, returning as-is")
        return data, None
    except Exception as e:
        print(f"[PromptExtractor] Error reading JSON file: {e}")
        import traceback
        traceback.print_exc()
        return None, None




def build_link_map(workflow_data):
    """Build a map from link_id to (source_node_id, source_slot, dest_node_id, dest_slot), including links from subgraphs"""
    link_map = {}

    # Add top-level links
    links = workflow_data.get('links', [])
    for link in links:
        # link format: [link_id, source_node_id, source_slot, dest_node_id, dest_slot, type]
        if len(link) >= 5:
            link_id = link[0]
            link_map[link_id] = {
                'source_node': link[1],
                'source_slot': link[2],
                'dest_node': link[3],
                'dest_slot': link[4]
            }

    # Add links from subgraph definitions
    if 'definitions' in workflow_data and 'subgraphs' in workflow_data['definitions']:
        for subgraph in workflow_data['definitions']['subgraphs']:
            if 'links' in subgraph:
                for link in subgraph['links']:
                    # Subgraph links can be either dict format or array format
                    if isinstance(link, dict):
                        link_id = link.get('id')
                        if link_id:
                            link_map[link_id] = {
                                'source_node': link.get('origin_id'),
                                'source_slot': link.get('origin_slot'),
                                'dest_node': link.get('target_id'),
                                'dest_slot': link.get('target_slot')
                            }
                    elif len(link) >= 5:
                        link_id = link[0]
                        link_map[link_id] = {
                            'source_node': link[1],
                            'source_slot': link[2],
                            'dest_node': link[3],
                            'dest_slot': link[4]
                        }

    return link_map


def build_node_map(workflow_data):
    """Build a map from node_id to node data, including nodes from subgraphs"""
    node_map = {}

    # Add top-level nodes
    nodes = workflow_data.get('nodes', [])
    for node in nodes:
        node_id = node.get('id')
        if node_id is not None:
            node_map[node_id] = node

    # Add nodes from subgraph definitions
    if 'definitions' in workflow_data and 'subgraphs' in workflow_data['definitions']:
        for subgraph in workflow_data['definitions']['subgraphs']:
            if 'nodes' in subgraph:
                for node in subgraph['nodes']:
                    node_id = node.get('id')
                    if node_id is not None:
                        node_map[node_id] = node

    return node_map


def determine_clip_text_encode_type(node_id, workflow_data, node_map):
    """
    Determine if a CLIPTextEncode node is positive or negative by checking
    what input it connects to in downstream nodes.
    Returns: 'positive', 'negative', or None if unclear
    """
    links = workflow_data.get('links', [])

    # Find all links where this node is the source
    for link in links:
        if len(link) >= 5:
            source_node_id = link[1]
            dest_node_id = link[3]
            dest_slot = link[4]

            if source_node_id == node_id:
                # This node is the source, check where it connects
                dest_node = node_map.get(dest_node_id)
                if dest_node:
                    dest_inputs = dest_node.get('inputs', [])
                    # Check the destination input name
                    if dest_slot < len(dest_inputs):
                        input_name = dest_inputs[dest_slot].get('name', '').lower()
                        if 'positive' in input_name:
                            return 'positive'
                        elif 'negative' in input_name:
                            return 'negative'

    return None


def traverse_to_find_text(node_id, input_slot, node_map, link_map, visited=None, max_depth=20):
    """
    Traverse backwards through node connections to find the actual prompt text.
    Follows through Concatenate, Find and Replace, and other string manipulation nodes.
    Returns the found text or empty string.
    """
    if visited is None:
        visited = set()

    if node_id in visited or max_depth <= 0:
        return ""
    visited.add(node_id)

    node = node_map.get(node_id)
    if not node:
        return ""

    node_type = node.get('type', '')
    widgets_values = node.get('widgets_values', [])
    inputs = node.get('inputs', [])

    # Check if this node has direct text in widgets_values
    if node_type in ['PrimitiveStringMultiline', 'PrimitiveString', 'String', 'Text']:
        # Return first string value
        for val in widgets_values:
            if isinstance(val, str) and val.strip():
                return val.strip()

    # CLIPTextEncode - check if text is in widgets or need to traverse
    if node_type in ['CLIPTextEncode', 'CLIPTextEncodeSDXL', 'CLIPTextEncodeFlux']:
        # Check widget values first
        for val in widgets_values:
            if isinstance(val, str) and len(val) > 10:  # Likely a prompt
                return val.strip()
        # Otherwise traverse the text input
        for inp in inputs:
            if inp.get('name') == 'text' and inp.get('link'):
                link_id = inp['link']
                link_info = link_map.get(link_id)
                if link_info:
                    return traverse_to_find_text(
                        link_info['source_node'],
                        link_info['source_slot'],
                        node_map, link_map, visited, max_depth - 1
                    )
        return ""

    # StringConcatenate - combine inputs
    if node_type in ['StringConcatenate', 'Text Concatenate', 'Concat String']:
        parts = []
        delimiter = " "
        # Get delimiter from widgets if present
        for val in widgets_values:
            if isinstance(val, str) and len(val) <= 3:
                delimiter = val
                break

        # Find string_a and string_b inputs
        for inp in inputs:
            name = inp.get('name', '')
            if name in ['string_a', 'string_b', 'text_a', 'text_b'] and inp.get('link'):
                link_id = inp['link']
                link_info = link_map.get(link_id)
                if link_info:
                    text = traverse_to_find_text(
                        link_info['source_node'],
                        link_info['source_slot'],
                        node_map, link_map, visited.copy(), max_depth - 1
                    )
                    if text:
                        parts.append(text)

        return delimiter.join(parts) if parts else ""

    # Text Find and Replace - traverse to first input
    if node_type in ['Text Find and Replace', 'FindReplace', 'String Replace']:
        # These just pass through modified text, traverse to input
        for inp in inputs:
            if inp.get('name') in ['text', 'string', 'input'] and inp.get('link'):
                link_id = inp['link']
                link_info = link_map.get(link_id)
                if link_info:
                    return traverse_to_find_text(
                        link_info['source_node'],
                        link_info['source_slot'],
                        node_map, link_map, visited, max_depth - 1
                    )

    # Florence2Run - has caption output
    if node_type in ['Florence2Run', 'Florence2']:
        # Can't traverse further, but check for cached caption in widgets
        for val in widgets_values:
            if isinstance(val, str) and len(val) > 20:
                return val.strip()
        return ""

    # easy showAnything - traverse input
    if node_type in ['easy showAnything', 'ShowText', 'Preview String']:
        for inp in inputs:
            if inp.get('link'):
                link_id = inp['link']
                link_info = link_map.get(link_id)
                if link_info:
                    return traverse_to_find_text(
                        link_info['source_node'],
                        link_info['source_slot'],
                        node_map, link_map, visited, max_depth - 1
                    )

    # PromptExtractor / WorkflowRenderer — text outputs are computed at runtime,
    # NOT stored in widgets_values (which contain file selector, toggles, etc.).
    # Without this guard the generic fallback below picks up the image filename.
    if node_type in ['PromptExtractor', 'RecipeExtractor', 'WorkflowRenderer', 'RecipeRenderer']:
        return ""

    # Generic: if node has a text/string output, check widgets
    for val in widgets_values:
        if isinstance(val, str) and len(val) > 20:
            return val.strip()

    # Try traversing first text input
    for inp in inputs:
        name = inp.get('name', '').lower()
        if ('text' in name or 'string' in name or 'prompt' in name) and inp.get('link'):
            link_id = inp['link']
            link_info = link_map.get(link_id)
            if link_info:
                result = traverse_to_find_text(
                    link_info['source_node'],
                    link_info['source_slot'],
                    node_map, link_map, visited, max_depth - 1
                )
                if result:
                    return result

    return ""


def extract_power_lora_loader(node):
    """Extract ALL LoRAs from Power Lora Loader (rgthree) node (regardless of active state)"""
    loras = []
    widgets_values = node.get('widgets_values', [])

    for val in widgets_values:
        if isinstance(val, dict):
            # Format: {"on": true, "lora": "path/to/lora.safetensors", "strength": 1.0, "strengthTwo": null}
            # Extract ALL LoRAs, not just active ones
            if val.get('lora'):
                lora_path = val['lora']
                strength = float(val.get('strength', 1.0))
                strength_two = val.get('strengthTwo')
                clip_strength = float(strength_two) if strength_two is not None else strength
                is_active = val.get('on', True)

                loras.append({
                    'name': os.path.splitext(os.path.basename(lora_path))[0],
                    'path': lora_path,
                    'model_strength': strength,
                    'clip_strength': clip_strength,
                    'active': is_active
                })

    return loras


def extract_lora_manager_stacker(node):
    """Extract ALL LoRAs from Lora Stacker (LoraManager) node (regardless of active state)"""
    loras = []
    widgets_values = node.get('widgets_values', [])

    # Format: widgets_values[1] contains array of LoRA objects
    # [{"name":"lora_name","strength":0.33,"active":true,"expanded":false,"clipStrength":0.33}, ...]
    for val in widgets_values:
        if isinstance(val, list):
            for lora in val:
                if isinstance(lora, dict):
                    lora_name = lora.get('name', '')
                    # Extract ALL LoRAs, not just active ones
                    if lora_name:
                        # Handle strength as string or number
                        strength = lora.get('strength', 1.0)
                        if isinstance(strength, str):
                            strength = float(strength)
                        clip_strength = lora.get('clipStrength', strength)
                        if isinstance(clip_strength, str):
                            clip_strength = float(clip_strength)
                        is_active = lora.get('active', True)

                        loras.append({
                            'name': lora_name,
                            'path': '',
                            'model_strength': float(strength),
                            'clip_strength': float(clip_strength),
                            'active': is_active
                        })

    return loras


def extract_wan_video_lora_select_multi(node):
    """Extract ALL LoRAs from WanVideoLoraSelectMulti node (regardless of active state)"""
    loras = []
    widgets_values = node.get('widgets_values', [])

    # WanVideoLoraSelectMulti stores LoRAs as pairs in widgets_values:
    # [lora_name_1, strength_1, lora_name_2, strength_2, ..., none, strength, bool, bool]
    # Parse pairs of (lora_name, strength)

    i = 0
    while i < len(widgets_values) - 1:
        lora_name = widgets_values[i]

        # Check if this is a string (potential LoRA name)
        if isinstance(lora_name, str):
            # Skip if it's "none" or empty
            if lora_name.lower() == 'none' or not lora_name.strip():
                i += 2  # Skip the strength value too
                continue

            # Next value should be the strength
            if i + 1 < len(widgets_values):
                strength_val = widgets_values[i + 1]

                # If next value is numeric, it's the strength for this LoRA
                if isinstance(strength_val, (int, float)):
                    strength = float(strength_val)

                    loras.append({
                        'name': os.path.splitext(os.path.basename(lora_name))[0],
                        'path': lora_name,
                        'model_strength': strength,
                        'clip_strength': strength,  # WanVideo doesn't separate model/clip strength
                        'active': True  # All LoRAs in the list are considered active
                    })

                    i += 2  # Move to next pair
                    continue

        # If we didn't process a pair, just move to next item
        i += 1

    # Legacy fallback for other possible formats
    for val in widgets_values:
        # Format 1: List of LoRA dictionaries
        if isinstance(val, list):
            for item in val:
                if isinstance(item, dict):
                    # Extract LoRA info from dictionary format
                    lora_name = item.get('lora') or item.get('name') or item.get('lora_name', '')
                    if lora_name and lora_name != 'None':
                        strength = item.get('strength') or item.get('model_strength', 1.0)
                        if isinstance(strength, str):
                            strength = float(strength) if strength else 1.0
                        else:
                            strength = float(strength)

                        clip_strength = item.get('clip_strength') or item.get('strengthTwo')
                        if clip_strength is not None:
                            if isinstance(clip_strength, str):
                                clip_strength = float(clip_strength) if clip_strength else strength
                            else:
                                clip_strength = float(clip_strength)
                        else:
                            clip_strength = strength

                        is_active = item.get('on', item.get('active', item.get('enabled', True)))

                        loras.append({
                            'name': os.path.splitext(os.path.basename(lora_name))[0],
                            'path': lora_name,
                            'model_strength': strength,
                            'clip_strength': clip_strength,
                            'active': is_active
                        })
                elif isinstance(item, str) and item and item != 'None':
                    # Format 2: Simple string list of LoRA names
                    loras.append({
                        'name': os.path.splitext(os.path.basename(item))[0],
                        'path': item,
                        'model_strength': 1.0,
                        'clip_strength': 1.0,
                        'active': True
                    })
        # Format 3: Dictionary containing LoRA info
        elif isinstance(val, dict):
            lora_name = val.get('lora') or val.get('name') or val.get('lora_name', '')
            if lora_name and lora_name != 'None':
                strength = val.get('strength') or val.get('model_strength', 1.0)
                if isinstance(strength, str):
                    strength = float(strength) if strength else 1.0
                else:
                    strength = float(strength)

                clip_strength = val.get('clip_strength') or val.get('strengthTwo')
                if clip_strength is not None:
                    if isinstance(clip_strength, str):
                        clip_strength = float(clip_strength) if clip_strength else strength
                    else:
                        clip_strength = float(clip_strength)
                else:
                    clip_strength = strength

                is_active = val.get('on', val.get('active', val.get('enabled', True)))

                loras.append({
                    'name': os.path.splitext(os.path.basename(lora_name))[0],
                    'path': lora_name,
                    'model_strength': strength,
                    'clip_strength': clip_strength,
                    'active': is_active
                })

    return loras


def extract_lora_loader_stack_rgthree(node):
    """Extract LoRAs from Lora Loader Stack (rgthree) node - supports up to 4 LoRAs"""
    loras = []
    widgets_values = node.get('widgets_values', [])

    # Lora Loader Stack (rgthree) stores LoRAs as pairs in widgets_values:
    # [lora_01, strength_01, lora_02, strength_02, lora_03, strength_03, lora_04, strength_04]
    # Parse pairs of (lora_name, strength) - max 4 LoRAs

    i = 0
    while i < len(widgets_values) - 1 and i < 8:  # Max 4 LoRAs = 8 values
        lora_name = widgets_values[i]

        # Check if this is a string (potential LoRA name)
        if isinstance(lora_name, str):
            # Skip if it's "None" or empty
            if lora_name == 'None' or not lora_name.strip():
                i += 2  # Skip the strength value too
                continue

            # Next value should be the strength
            if i + 1 < len(widgets_values):
                strength_val = widgets_values[i + 1]

                # If next value is numeric, it's the strength for this LoRA
                if isinstance(strength_val, (int, float)):
                    strength = float(strength_val)

                    loras.append({
                        'name': os.path.splitext(os.path.basename(lora_name))[0],
                        'path': lora_name,
                        'model_strength': strength,
                        'clip_strength': strength,  # No separate model/clip strength
                        'active': True  # All LoRAs are active (no on/off toggle)
                    })

                    i += 2  # Move to next pair
                    continue

        # If we didn't process a pair, move to next item
        i += 1

    return loras


def extract_standard_lora_loader(node):
    """Extract LoRA from standard LoraLoader or LoraLoaderModelOnly node"""
    widgets_values = node.get('widgets_values', [])

    if len(widgets_values) < 1:
        return []

    lora_name = widgets_values[0] if isinstance(widgets_values[0], str) else ''
    if not lora_name:
        return []

    model_strength = 1.0
    clip_strength = 1.0

    if len(widgets_values) >= 2:
        model_strength = float(widgets_values[1]) if widgets_values[1] is not None else 1.0
    if len(widgets_values) >= 3:
        clip_strength = float(widgets_values[2]) if widgets_values[2] is not None else model_strength
    else:
        clip_strength = model_strength

    # Standard LoRA loaders are always active (no on/off toggle)
    return [{
        'name': os.path.splitext(os.path.basename(lora_name))[0],
        'path': lora_name,
        'model_strength': model_strength,
        'clip_strength': clip_strength,
        'active': True
    }]


def extract_loras_from_node(node):
    """
    Extract LoRAs from any supported LoRA loader node type.
    Returns a list of LoRA dicts: {name, path, model_strength, clip_strength}
    """
    node_type = node.get('type', '')

    # Power Lora Loader (rgthree) - multiple LoRAs
    if node_type == 'Power Lora Loader (rgthree)':
        return extract_power_lora_loader(node)

    # Lora Stacker (LoraManager) variants
    lora_stacker_types = [
        'Lora Stacker (LoraManager)',
        'LoRA Stacker',
        'LoraStacker',
        'LoRA Stacker (LoRA Manager)'
    ]
    if node_type in lora_stacker_types:
        return extract_lora_manager_stacker(node)

    # WanVideoLoraSelectMulti (video LoRA loader)
    if node_type == 'WanVideoLoraSelectMulti':
        return extract_wan_video_lora_select_multi(node)

    # Lora Loader Stack (rgthree) - up to 4 LoRAs
    if node_type == 'Lora Loader Stack (rgthree)':
        return extract_lora_loader_stack_rgthree(node)

    # Standard LoRA loaders
    standard_loader_types = [
        'LoraLoader',
        'LoraLoaderModelOnly',
        'LoRALoader',  # Alternative casing
        'LoraLoaderKJNodes',  # KJNodes variant
    ]
    if node_type in standard_loader_types:
        return extract_standard_lora_loader(node)

    return []


def is_lora_node(node_type):
    """Check if a node type is any kind of LoRA loader"""
    lora_node_types = [
        'Power Lora Loader (rgthree)',
        'Lora Loader Stack (rgthree)',
        'Lora Stacker (LoraManager)',
        'LoRA Stacker',
        'LoraStacker',
        'LoRA Stacker (LoRA Manager)',
        'LoraLoader',
        'LoraLoaderModelOnly',
        'LoRALoader',
        'LoraLoaderKJNodes',
        'WanVideoLoraSelectMulti',
    ]
    return node_type in lora_node_types


def collect_lora_model_chain(start_node_id, node_map, link_map, visited=None):
    """
    Traverse backwards through MODEL connections to collect all LoRAs in a chain.
    This works for any mix of LoRA loader types (Power Lora, standard LoraLoader, Stacker, etc.)

    Returns a tuple of (loras, titles) where:
      - loras: list of all LoRAs found in the chain
      - titles: list of all node titles in the chain (for determining high/low assignment)
    """
    if visited is None:
        visited = set()

    if start_node_id in visited:
        return [], []
    visited.add(start_node_id)

    node = node_map.get(start_node_id)
    if not node:
        return [], []

    node_type = node.get('type', '')
    all_loras = []
    all_titles = []

    # Extract LoRAs from this node if it's a LoRA loader AND it's actually connected
    if is_lora_node(node_type):
        # Check if this LoRA node's MODEL output is connected to something
        outputs = node.get('outputs', [])
        has_connected_output = False
        for output in outputs:
            output_type = output.get('type', '')
            # Check if this is a MODEL, LORA_STACK, or WANVIDLORA output with connections
            if output_type in ['MODEL', 'LORA_STACK', 'WANVIDLORA']:
                links = output.get('links')
                # links can be None, [], or a list with items
                if links is not None and len(links) > 0:
                    has_connected_output = True
                    break

        # Only extract LoRAs if this node's output is connected
        if has_connected_output:
            node_loras = extract_loras_from_node(node)
            all_loras.extend(node_loras)
            title = node.get('title', '')
            if title:
                all_titles.append(title)

    # Look for MODEL, lora_stack, or WANVIDLORA input connections and traverse backwards
    inputs = node.get('inputs', [])
    for inp in inputs:
        input_name = inp.get('name', '')
        input_type = inp.get('type', '')
        # Follow MODEL, model, lora_stack, or WANVIDLORA connections
        if (input_name in ['model', 'MODEL', 'lora_stack', 'lora'] or input_type == 'WANVIDLORA') and inp.get('link'):
            link_id = inp['link']
            link_info = link_map.get(link_id)
            if link_info:
                source_node_id = link_info['source_node']
                # Recursively collect LoRAs from the chain
                chain_loras, chain_titles = collect_lora_model_chain(source_node_id, node_map, link_map, visited)
                all_loras.extend(chain_loras)
                all_titles.extend(chain_titles)

    return all_loras, all_titles


# Node types that load checkpoints or diffusion models (not LoRA, VAE, or CLIP loaders)
MODEL_LOADER_TYPES = [
    'CheckpointLoader',
    'CheckpointLoaderSimple',
    'CheckpointLoaderKJ',
    'CheckpointLoaderNF4',
    'UNETLoader',
    'UnetLoaderGGUF',
    'DiffusionModelLoader',
    'DiffusionModelLoaderKJ',
    'WanVideoModelLoader',
    'SeaArtUnetLoader',
    'CyberdyneModelHub',
    'PromptModelLoader',
]


def is_model_loader_node(node_type):
    """Check if a node type is a checkpoint or diffusion model loader"""
    return node_type in MODEL_LOADER_TYPES


def get_model_name_from_node(node, prompt_node=None):
    """
    Extract the model/checkpoint name from a model loader node.
    Checks both workflow widgets_values and API-format inputs.
    Returns the model name string or None.
    """
    node_type = node.get('type', '')

    # From API format (prompt_data) — most reliable for active nodes
    if prompt_node and isinstance(prompt_node, dict):
        inputs = prompt_node.get('inputs', {})
        for key in ['ckpt_name', 'unet_name', 'model_name', 'diffusion_model', 'model', 'model_path']:
            val = inputs.get(key)
            if val and isinstance(val, str):
                return val

    # From workflow widgets_values — fallback
    widgets = node.get('widgets_values', [])
    if widgets and isinstance(widgets[0], str):
        return widgets[0]

    return None


def trace_to_model_loader(node_id, node_map, link_map, visited=None, max_depth=20):
    """
    Trace backwards through MODEL connections to find the model loader node at the root.
    Passes through LoRA nodes, ModelSamplingSD3, etc.
    Returns the model loader node ID, or None if not found.
    """
    if visited is None:
        visited = set()
    if max_depth <= 0 or node_id in visited:
        return None

    visited.add(node_id)
    node = node_map.get(node_id)
    if not node:
        return None

    if is_model_loader_node(node.get('type', '')):
        return node_id

    # Trace backwards through MODEL input
    inputs = node.get('inputs', [])
    for inp in inputs:
        inp_name = inp.get('name', '')
        inp_type = inp.get('type', '')
        if (inp_name in ['model', 'MODEL'] or inp_type == 'MODEL') and inp.get('link'):
            link_info = link_map.get(inp['link'])
            if link_info:
                result = trace_to_model_loader(link_info['source_node'], node_map, link_map, visited, max_depth - 1)
                if result:
                    return result

    return None


def collect_lora_stack_chain(start_node_id, node_map, link_map, visited=None):
    """
    Traverse backwards through lora_stack connections to collect all LoRAs in a chain.
    This is specifically for LORA_STACK type connections (Lora Stacker nodes).
    Returns a tuple of (loras, titles) where:
      - loras: list of all LoRAs found in the chain
      - titles: list of all node titles in the chain (for determining high/low assignment)
    """
    if visited is None:
        visited = set()

    if start_node_id in visited:
        return [], []
    visited.add(start_node_id)

    node = node_map.get(start_node_id)
    if not node:
        return [], []

    node_type = node.get('type', '')
    all_loras = []
    all_titles = []

    # Check if this node is a LoRA Stacker type
    lora_stacker_types = [
        'Lora Stacker (LoraManager)',
        'LoRA Stacker',
        'LoraStacker',
        'LoRA Stacker (LoRA Manager)'
    ]

    if node_type in lora_stacker_types:
        # Extract LoRAs from this node
        node_loras = extract_lora_manager_stacker(node)
        all_loras.extend(node_loras)
        # Track the title for this node
        title = node.get('title', '')
        if title:
            all_titles.append(title)

    # Look for lora_stack input connection and traverse backwards
    inputs = node.get('inputs', [])
    for inp in inputs:
        if inp.get('name') == 'lora_stack' and inp.get('link'):
            link_id = inp['link']
            link_info = link_map.get(link_id)
            if link_info:
                source_node_id = link_info['source_node']
                # Recursively collect LoRAs from the chain
                chain_loras, chain_titles = collect_lora_stack_chain(source_node_id, node_map, link_map, visited)
                all_loras.extend(chain_loras)
                all_titles.extend(chain_titles)

    return all_loras, all_titles


def find_lora_chain_terminals(workflow_data, node_map, link_map):
    """
    Find terminal nodes for LoRA chains - nodes that receive MODEL input from LoRA loaders
    but are NOT LoRA loaders themselves (e.g., KSampler, other processing nodes).

    Returns a list of terminal node IDs that have LoRA chains feeding into them.
    """
    terminals = []

    # List of input names that receive MODEL type connections
    model_input_names = [
        'model', 'MODEL',
        'model_high_noise', 'model_low_noise',  # WanMoeKSamplerAdvanced
        'base_model', 'refiner_model',  # SDXL workflows
        'unet',  # Some custom nodes
    ]

    # Collect all nodes including those in subgraphs
    all_nodes = []
    if 'nodes' in workflow_data:
        all_nodes.extend(workflow_data.get('nodes', []))

    # Add nodes from subgraph definitions
    if 'definitions' in workflow_data and 'subgraphs' in workflow_data['definitions']:
        subgraph_count = len(workflow_data['definitions']['subgraphs'])
        subgraph_node_count = 0
        for subgraph in workflow_data['definitions']['subgraphs']:
            if 'nodes' in subgraph:
                subgraph_nodes = subgraph['nodes']
                subgraph_node_count += len(subgraph_nodes)
                all_nodes.extend(subgraph_nodes)
        print(f"[PromptExtractor] find_lora_chain_terminals: {len(workflow_data.get('nodes', []))} top-level nodes + {subgraph_node_count} subgraph nodes from {subgraph_count} subgraphs = {len(all_nodes)} total")

    for node in all_nodes:
        node_id = node.get('id')
        node_type = node.get('type', '')

        # Skip LoRA loader nodes - we want non-LoRA nodes that receive model input
        if is_lora_node(node_type):
            continue

        # Check if this node receives MODEL input
        # NOTE: Some nodes have multiple MODEL inputs (e.g., model, model_1 for high/low)
        inputs = node.get('inputs', [])
        for inp in inputs:
            inp_name = inp.get('name', '')
            inp_type = inp.get('type', '')

            # Check if this is a MODEL or WANVIDLORA type input (by type or by name matching)
            is_model_input = (inp_type in ['MODEL', 'WANVIDLORA'] or inp_name in model_input_names)

            if is_model_input and inp.get('link'):
                link_id = inp['link']
                link_info = link_map.get(link_id)
                if link_info:
                    source_id = link_info['source_node']

                    # Trace back through the MODEL chain to find a LoRA loader
                    # (might go through intermediate nodes like ModelSamplingSD3)
                    lora_source_id = trace_to_lora_loader(source_id, node_map, link_map, set())

                    if lora_source_id:
                        # Get the label to better identify high/low
                        inp_label = inp.get('label', '').lower()

                        # This node receives MODEL from a LoRA loader (possibly through intermediate nodes)
                        terminals.append({
                            'terminal_id': node_id,
                            'terminal_type': node_type,
                            'terminal_title': node.get('title', ''),
                            'lora_source_id': lora_source_id,
                            'input_name': inp_name,  # Track which input (model, model_1, etc)
                            'input_label': inp_label  # Track the label (model H, model L)
                        })

    return terminals


def trace_to_lora_loader(node_id, node_map, link_map, visited, max_depth=10):
    """
    Trace backwards through MODEL connections to find the first LoRA loader node.
    Returns the LoRA loader node ID, or None if no LoRA loader is found.
    """
    if max_depth <= 0 or node_id in visited:
        return None

    visited.add(node_id)

    node = node_map.get(node_id)
    if not node:
        return None

    # Check if this node is a LoRA loader
    if is_lora_node(node.get('type', '')):
        return node_id

    # Otherwise, trace back through MODEL or WANVIDLORA input
    inputs = node.get('inputs', [])
    for inp in inputs:
        inp_name = inp.get('name', '')
        inp_type = inp.get('type', '')
        # Follow MODEL, model, lora, or WANVIDLORA connections
        if (inp_name in ['model', 'MODEL', 'lora'] or inp_type in ['MODEL', 'WANVIDLORA']) and inp.get('link'):
            link_id = inp['link']
            link_info = link_map.get(link_id)
            if link_info:
                source_node_id = link_info['source_node']
                result = trace_to_lora_loader(source_node_id, node_map, link_map, visited, max_depth - 1)
                if result:
                    return result

    return None


# ── Robust graph-based prompt extraction (API / prompt-dict format) ───────────
#
# ComfyUI saves two representations inside image metadata:
#   • "workflow"  → human-facing graph  (nodes[], links[])   ← handled above
#   • "prompt"    → execution graph     ({node_id: {class_type, inputs}})
#
# In the execution graph, inter-node connections are expressed as
#   ["<source_node_id>", <output_slot>]
# rather than plain strings.  The existing code already reads direct string
# values from CLIPTextEncode.inputs["text"], but silently skips the case where
# that value is a connection reference — which is what happens when a custom
# node (Prompt Verify, TextMultiline, etc.) feeds the CLIP encoder.
#
# The functions below implement the spec from the task brief:
#   1. Find sampler anchor nodes in the execution graph
#   2. Follow positive / negative connections recursively
#   3. Consult a registry of known node types first
#   4. Fall back to smart heuristic scan when the registry misses

# Registry: node class_type → list of input keys that may contain the prompt text
_PROMPT_NODE_REGISTRY = {
    "CLIPTextEncode":           ["text"],
    "CLIPTextEncodeSDXL":       ["text", "text_g", "text_l"],
    "CLIPTextEncodeFlux":       ["text", "clip_l", "t5xxl"],
    "Prompt Verify":            ["prompt_verify_master", "text", "prompt"],
    "TextMultiline":            ["text"],
    "String":                   ["text", "string"],
    "PrimitiveStringMultiline": ["text", "string"],
    "PrimitiveString":          ["text", "string"],
    "PromptManager":            ["text"],
    "PromptManagerAdvanced":    ["text"],
    "ShowText":                 ["text"],
    "Text Concatenate":         ["text_a", "text_b", "string_a", "string_b"],
    "StringConcatenate":        ["string_a", "string_b"],
    "easy showAnything":        ["text"],
}

# Sampler class types treated as anchor nodes
_SAMPLER_CLASS_TYPES = {
    "KSampler", "KSamplerAdvanced",
    "WanVideoKSampler", "WanMoeKSamplerAdvanced",
    "KSamplerSelect", "SamplerCustom", "SamplerCustomAdvanced",
}

# Nodes whose outputs we should never mistake for a prompt
_BLACKLISTED_TRAVERSAL_TYPES = {
    "MetaPromptExtractor", "PromptExtractor", "RecipeExtractor",
    "WorkflowRenderer", "RecipeRenderer", "WorkflowBuilder", "RecipeBuilder",
}


def _is_connection_ref(value):
    """Return True when *value* is a ComfyUI node-output reference: ["node_id", slot]."""
    return (
        isinstance(value, (list, tuple))
        and len(value) == 2
        and isinstance(value[1], int)
    )


def _find_sampler_nodes_api(data):
    """
    Scan execution-graph dict for sampler anchor nodes.
    Returns list of (node_id_str, node_dict) sorted so the LAST one wins
    (matching the brief: "multiple samplers → pick LAST valid one").
    """
    samplers = []
    for nid, nd in data.items():
        if not isinstance(nd, dict):
            continue
        ct = nd.get("class_type", "")
        inputs = nd.get("inputs", {})
        # Match by class_type OR by having positive/negative inputs
        if ct in _SAMPLER_CLASS_TYPES or (
            "positive" in inputs or "negative" in inputs
        ):
            samplers.append((nid, nd))
    return samplers


def _resolve_prompt_api(node_id_str, data, visited=None):
    """
    Recursively resolve a text prompt starting from *node_id_str* in the
    execution-graph dict *data*.

    Returns the best prompt string found, or "".
    """
    if visited is None:
        visited = set()
    if node_id_str in visited:
        return ""
    visited.add(node_id_str)

    node_data = data.get(str(node_id_str))
    if not node_data or not isinstance(node_data, dict):
        return ""

    class_type = node_data.get("class_type", "")
    inputs = node_data.get("inputs", {})

    if class_type in _BLACKLISTED_TRAVERSAL_TYPES:
        return ""

    # ── 1. Registry: known node types ────────────────────────────────────────
    known_keys = _PROMPT_NODE_REGISTRY.get(class_type)
    if known_keys:
        for key in known_keys:
            val = inputs.get(key)
            if val is None:
                continue
            if isinstance(val, str) and val.strip():
                return val.strip()
            if _is_connection_ref(val):
                result = _resolve_prompt_api(str(val[0]), data, visited)
                if result:
                    return result
        # Registry node found but no text — stop, don't fall through to generic
        # (avoids picking up unrelated widget values from CLIP encoders)
        return ""

    # ── 2. Unknown node: check all string inputs that might be text ───────────
    for key, val in inputs.items():
        if isinstance(val, str) and val.strip():
            if _looks_like_prompt(val):
                return val.strip()
        elif _is_connection_ref(val):
            # Follow connection — but only for text-ish input names
            lkey = key.lower()
            if any(kw in lkey for kw in ("text", "prompt", "string", "caption")):
                result = _resolve_prompt_api(str(val[0]), data, visited)
                if result:
                    return result

    # ── 3. Try all connections as a last resort ───────────────────────────────
    for key, val in inputs.items():
        if _is_connection_ref(val):
            result = _resolve_prompt_api(str(val[0]), data, visited)
            if result:
                return result

    return ""


def _looks_like_prompt(text):
    """
    Heuristic filter: return True when *text* is likely a human-written prompt
    and not a filename, path, JSON blob, or purely numeric string.
    """
    if not text or len(text) < 30:
        return False
    if ' ' not in text:
        return False                              # single token / filename
    stripped = text.strip()
    if stripped.startswith(("{", "[", "http", "/")):
        return False                              # JSON / URL / path
    if any(stripped.lower().endswith(ext) for ext in
           (".png", ".jpg", ".jpeg", ".webp", ".safetensors", ".ckpt", ".pt")):
        return False                              # file path
    # Reject strings that are >60 % digits / punctuation
    alpha_ratio = sum(1 for c in stripped if c.isalpha()) / max(len(stripped), 1)
    if alpha_ratio < 0.4:
        return False
    return True


def _fallback_scan_api(data):
    """
    Last-resort heuristic: scan ALL string values in the execution graph
    and return the most 'prompt-like' one (longest with commas / natural language).
    Used only when graph traversal finds nothing.
    """
    candidates = []
    for nid, nd in data.items():
        if not isinstance(nd, dict):
            continue
        class_type = nd.get("class_type", "")
        if class_type in _BLACKLISTED_TRAVERSAL_TYPES:
            continue
        inputs = nd.get("inputs", {})
        for key, val in inputs.items():
            if not isinstance(val, str):
                continue
            if not _looks_like_prompt(val):
                continue
            # Score: length + comma density (commas are common in SD prompts)
            score = len(val) + val.count(",") * 5
            candidates.append((score, val.strip()))
    if not candidates:
        return ""
    candidates.sort(reverse=True)
    return candidates[0][1]


def _extract_prompts_via_graph_traversal(data):
    """
    High-level driver: find sampler anchors, resolve positive and negative
    prompts via recursive graph traversal, and return (positive_str, negative_str).

    Operates purely on the ComfyUI execution-graph dict (prompt_data / API format).
    Falls back to heuristic scan if graph traversal yields nothing.
    """
    if not isinstance(data, dict):
        return "", ""

    positive_str = ""
    negative_str = ""

    samplers = _find_sampler_nodes_api(data)
    print(f"{TAG} [graph-traversal] Found {len(samplers)} sampler anchor(s) in execution graph")

    # Iterate samplers in REVERSE so we end up with the last valid one
    for sampler_id, sampler_node in reversed(samplers):
        inputs = sampler_node.get("inputs", {})

        # ── Positive ─────────────────────────────────────────────────────────
        if not positive_str:
            pos_ref = inputs.get("positive")
            if _is_connection_ref(pos_ref):
                positive_str = _resolve_prompt_api(str(pos_ref[0]), data, set())
                if positive_str:
                    print(f"{TAG} [graph-traversal] Resolved positive prompt via sampler {sampler_id} "
                          f"({len(positive_str)} chars)")

        # ── Negative ─────────────────────────────────────────────────────────
        if not negative_str:
            neg_ref = inputs.get("negative")
            if _is_connection_ref(neg_ref):
                negative_str = _resolve_prompt_api(str(neg_ref[0]), data, set())
                if negative_str:
                    print(f"{TAG} [graph-traversal] Resolved negative prompt via sampler {sampler_id} "
                          f"({len(negative_str)} chars)")

        if positive_str and negative_str:
            break  # Both found — stop iterating

    # ── Fallback: heuristic scan ──────────────────────────────────────────────
    if not positive_str and not negative_str:
        print(f"{TAG} [graph-traversal] No prompts via sampler anchors — running fallback scan")
        positive_str = _fallback_scan_api(data)

    return positive_str, negative_str


def parse_workflow_for_prompts(prompt_data, workflow_data=None):
    """
    Parse workflow/prompt data to extract positive/negative prompts and LoRAs

    Returns dict with:
        - positive_prompt: str
        - negative_prompt: str
        - loras_a: list of {name, model_strength, clip_strength} - first lora loader (High noise)
        - loras_b: list of {name, model_strength, clip_strength} - second lora loader (Low noise)
        - models_a: list of model names - first/high model chain
        - models_b: list of model names - second/low model chain
    """
    result = {
        'positive_prompt': '',
        'negative_prompt': '',
        'loras_a': [],
        'loras_b': [],
        'models_a': [],
        'models_b': []
    }

    if not prompt_data and not workflow_data:
        return result

    # Check if prompt_data is parsed A1111 parameters (from JavaScript)
    if isinstance(prompt_data, dict) and 'prompt' in prompt_data and 'loras' in prompt_data:
        print("[PromptExtractor] Processing A1111 parsed parameters")
        result['positive_prompt'] = prompt_data.get('prompt', '')
        result['negative_prompt'] = prompt_data.get('negative_prompt', '')

        # Add all LoRAs to stack_a (A1111 doesn't have dual stacks)
        for lora in prompt_data.get('loras', []):
            # Skip blacklisted LoRAs
            if is_lora_blacklisted(lora['name']):
                continue
            result['loras_a'].append({
                'name': lora['name'],
                'model_strength': lora['model_strength'],
                'clip_strength': lora['clip_strength'],
                'active': True
            })

        print(f"[PromptExtractor] Extracted A1111: {len(result['loras_a'])} LoRAs, prompt length: {len(result['positive_prompt'])}")

        # Extract model if present
        model_name = prompt_data.get('model', '')
        if model_name:
            result['models_a'].append(model_name)
            print(f"[PromptExtractor] A1111 Model: {model_name}")

        return result

    # Build maps for traversal if workflow_data is available
    node_map = {}
    link_map = {}
    if workflow_data and isinstance(workflow_data, dict) and 'nodes' in workflow_data:
        node_map = build_node_map(workflow_data)
        link_map = build_link_map(workflow_data)

    # Use prompt_data (API format) as primary source
    data = prompt_data if prompt_data else {}

    # If workflow_data exists but prompt_data doesn't, try to extract from workflow
    if not prompt_data and workflow_data:
        # Workflow format has 'nodes' array with widget values
        data = convert_workflow_to_prompt_format(workflow_data)

    if not isinstance(data, dict):
        return result

    # Track found prompts and LoRAs
    positive_prompts = []
    negative_prompts = []
    loras_a = []
    loras_b = []
    lora_names_seen_a = set()
    lora_names_seen_b = set()

    # Track models extracted from our own nodes (PromptExtractor embedded data)
    _pe_extracted_models = []

    # Initialize lora_chains early so embedded data extraction can append to it
    lora_chains = []

    # Collect embedded data candidates from PromptExtractor/WorkflowRenderer nodes
    # (resolved after the loop — WorkflowRenderer takes priority if both are present)
    _embedded_candidates = []
    _embedded_positive_fallback = []
    _embedded_negative_fallback = []

    # Iterate through all nodes (workflow format) - including subgraphs
    all_workflow_nodes = []
    if workflow_data:
        # Add top-level nodes
        if 'nodes' in workflow_data:
            all_workflow_nodes.extend(workflow_data.get('nodes', []))

        # Add nodes from subgraph definitions
        if 'definitions' in workflow_data and 'subgraphs' in workflow_data['definitions']:
            for subgraph in workflow_data['definitions']['subgraphs']:
                if 'nodes' in subgraph:
                    all_workflow_nodes.extend(subgraph['nodes'])

    if all_workflow_nodes:
        def _parse_json_dict(value):
            if isinstance(value, dict):
                return value
            if isinstance(value, str) and value.strip():
                try:
                    parsed = json.loads(value)
                    return parsed if isinstance(parsed, dict) else {}
                except Exception:
                    return {}
            return {}

        def _build_embedded_from_builder_ui(node):
            props = node.get('properties') if isinstance(node.get('properties'), dict) else {}
            ui_state = _parse_json_dict(props.get('we_ui_state'))
            if not ui_state:
                ui_state = _parse_json_dict(props.get('we_override_data'))
            if not ui_state:
                return None

            fam = ui_state.get('_family') or ui_state.get('family') or 'sdxl'
            clip_names = ui_state.get('clip_names', [])
            if isinstance(clip_names, str):
                clip_names = [clip_names] if clip_names else []

            sampler = {
                'steps_a': ui_state.get('steps_a', 20),
                'steps_b': ui_state.get('steps_b'),
                'cfg': ui_state.get('cfg', 5.0),
                'denoise': 1.0,
                'seed_a': ui_state.get('seed_a', 0),
                'seed_b': ui_state.get('seed_b'),
                'sampler_name': ui_state.get('sampler_name', 'euler'),
                'scheduler': ui_state.get('scheduler', 'simple'),
            }
            resolution = {
                'width': ui_state.get('width', 768),
                'height': ui_state.get('height', 1280),
                'batch_size': ui_state.get('batch_size', 1),
                'length': ui_state.get('length'),
            }

            loras_a = ui_state.get('loras_a', []) if isinstance(ui_state.get('loras_a', []), list) else []
            loras_b = ui_state.get('loras_b', []) if isinstance(ui_state.get('loras_b', []), list) else []
            lora_avail = ui_state.get('_lora_availability', {})
            if not isinstance(lora_avail, dict):
                lora_avail = {}

            return {
                'positive_prompt': ui_state.get('positive_prompt', ''),
                'negative_prompt': ui_state.get('negative_prompt', ''),
                'model_a': ui_state.get('model_a', ''),
                'model_b': ui_state.get('model_b', ''),
                'loras_a': loras_a,
                'loras_b': loras_b,
                'vae': {
                    'name': ui_state.get('vae', ''),
                    'source': 'workflow_data',
                },
                'clip': {
                    'names': clip_names,
                    'type': '',
                    'source': 'workflow_data',
                },
                'sampler': sampler,
                'resolution': resolution,
                'model_family': fam,
                'model_family_label': fam,  # Simplified: label = family name
                'lora_availability': lora_avail,
            }

        for node in all_workflow_nodes:
            if not isinstance(node, dict):
                continue

            node_type = node.get('type', '')
            node_id = node.get('id')
            title = node.get('title', '')
            widgets_values = node.get('widgets_values', [])
            inputs = node.get('inputs', [])

            # Extract prompts - with traversal if needed
            if node_type in ['CLIPTextEncode', 'CLIPTextEncodeSDXL', 'CLIPTextEncodeFlux']:
                # Determine positive/negative by checking output connections (most reliable)
                connection_type = determine_clip_text_encode_type(node_id, workflow_data, node_map)

                # Fallback to title checking if connections don't give us an answer
                if not connection_type:
                    title_lower = title.lower() if title else ""
                    if 'negative' in title_lower:
                        connection_type = 'negative'
                    elif 'positive' in title_lower:
                        connection_type = 'positive'
                    else:
                        # Default to positive if no clear indicator
                        connection_type = 'positive'

                # First try to get text directly from widgets
                text_found = ""
                for val in widgets_values:
                    if isinstance(val, str) and len(val) > 10:
                        text_found = val.strip()
                        break

                # If text input is connected, traverse to find actual prompt
                for inp in inputs:
                    if inp.get('name') == 'text' and inp.get('link'):
                        link_id = inp['link']
                        link_info = link_map.get(link_id)
                        if link_info:
                            traversed_text = traverse_to_find_text(
                                link_info['source_node'],
                                link_info['source_slot'],
                                node_map, link_map, set(), 20
                            )
                            if traversed_text:
                                text_found = traversed_text

                if text_found:
                    if connection_type == 'negative':
                        negative_prompts.append(text_found)
                    else:
                        positive_prompts.append(text_found)

            # PromptManager nodes
            elif node_type == 'PromptManager':
                for val in widgets_values:
                    if isinstance(val, str) and len(val) > 20:
                        positive_prompts.append(val.strip())
                        break

            elif node_type == 'PromptManagerAdvanced':
                # Widget order: [category, name, use_prompt_input, use_lora_input, text, swap_lora_outputs]
                pm_text = widgets_values[4] if len(widgets_values) > 4 else None
                if pm_text and isinstance(pm_text, str) and len(pm_text.strip()) > 0:
                    positive_prompts.append(pm_text.strip())
                else:
                    # Fallback: find first long string
                    for val in widgets_values:
                        if isinstance(val, str) and len(val) > 20:
                            positive_prompts.append(val.strip())
                            break

            # PromptExtractor / WorkflowBuilder / WorkflowRenderer nodes — collect
            # embedded extracted_data. Also accept legacy RecipeRenderer.
            elif node_type in ('PromptExtractor', 'RecipeExtractor', 'WorkflowBuilder', 'WorkflowRenderer', 'RecipeBuilder', 'RecipeRenderer'):
                ext_data = None
                # Builder videos now persist authoritative UI state in properties.
                # Prefer that over stale extracted_data snapshots when available.
                if node_type in ('WorkflowBuilder', 'RecipeBuilder'):
                    ext_data = _build_embedded_from_builder_ui(node)
                if not ext_data:
                    ext_data = node.get('extracted_data')
                if ext_data and isinstance(ext_data, dict):
                    _embedded_candidates.append((node_type, node_id, title, ext_data))

            # PrimitiveStringMultiline - direct prompt text (only add if connected to something)
            elif node_type == 'PrimitiveStringMultiline':
                # Check title for hints (must be explicit)
                title_lower = title.lower() if title else ""
                is_negative = 'negative' in title_lower
                is_positive = 'positive' in title_lower or not is_negative  # Default to positive if not explicitly negative

                for val in widgets_values:
                    if isinstance(val, str) and len(val) > 20:
                        if is_negative:
                            negative_prompts.append(val.strip())
                        else:
                            positive_prompts.append(val.strip())
                        break

    # ========================================
    # RESOLVE EMBEDDED DATA (PromptExtractor vs RecipeRenderer)
    # ========================================
    # Priority when multiple embedded sources are present:
    #   1. RecipeRenderer / WorkflowRenderer (actual render source)
    #   2. RecipeBuilder
    #   3. PromptExtractor
    if _embedded_candidates:
        has_render = any(nt in ('WorkflowRenderer', 'RecipeRenderer') for nt, *_ in _embedded_candidates)
        has_builder = any(nt in ('WorkflowBuilder', 'RecipeBuilder') for nt, *_ in _embedded_candidates)
        builder_prompt_candidate = None

        if has_render:
            chosen = [
                c for c in _embedded_candidates
                if c[0] in ('WorkflowRenderer', 'RecipeRenderer')
            ]
            if len(_embedded_candidates) > len(chosen):
                print("[PromptExtractor] Multiple embedded sources found — preferring RecipeRenderer")
        elif has_builder:
            chosen = [c for c in _embedded_candidates if c[0] in ('WorkflowBuilder', 'RecipeBuilder')]
            if len(_embedded_candidates) > len(chosen):
                print("[PromptExtractor] Both PromptExtractor and Builder found — preferring Builder embedded data")

            # When multiple builder nodes are present, select a single prompt source.
            # Prefer the first builder (stable workflow order), then first non-empty prompt.
            for c in chosen:
                ext_data = c[3] if len(c) > 3 and isinstance(c[3], dict) else {}
                if not builder_prompt_candidate:
                    builder_prompt_candidate = c
                if ext_data.get('positive_prompt', '').strip() or ext_data.get('negative_prompt', '').strip():
                    builder_prompt_candidate = c
                    break
        else:
            chosen = _embedded_candidates

        for node_type, node_id, title, ext_data in chosen:
            # Builder-only workflows can contain several builder nodes from
            # multi-branch generation graphs; use one prompt source instead of
            # concatenating all builder prompts.
            if node_type not in ['WorkflowBuilder', 'RecipeBuilder'] or not has_render:
                use_for_prompt = True
                if node_type in ['WorkflowBuilder', 'RecipeBuilder'] and builder_prompt_candidate:
                    use_for_prompt = (node_id == builder_prompt_candidate[1])

                if use_for_prompt:
                    ext_pos = ext_data.get('positive_prompt', '').strip()
                    ext_neg = ext_data.get('negative_prompt', '').strip()
                    if ext_pos:
                        _embedded_positive_fallback.append(ext_pos)
                    if ext_neg:
                        _embedded_negative_fallback.append(ext_neg)

            # Extract LoRAs from embedded data (with active/available state)
            for stack_label, key in [('A', 'loras_a'), ('B', 'loras_b')]:
                ext_loras = ext_data.get(key, [])
                if not ext_loras:
                    continue
                chain_loras_list = []
                for lora_item in ext_loras:
                    if not isinstance(lora_item, dict):
                        continue
                    lora_name = lora_item.get('name', '')
                    if not lora_name or is_lora_blacklisted(lora_name):
                        continue
                    strength = float(lora_item.get('strength', lora_item.get('model_strength', 1.0)))
                    clip_strength = float(lora_item.get('clip_strength', strength))
                    chain_loras_list.append({
                        'name': lora_name,
                        'path': lora_item.get('path', lora_name),
                        'model_strength': strength,
                        'clip_strength': clip_strength,
                        'active': lora_item.get('active', True),
                        'available': lora_item.get('available', True),
                    })
                if chain_loras_list:
                    active_count = sum(1 for lr in chain_loras_list if lr.get('active', True))
                    avail_count = sum(1 for lr in chain_loras_list if lr.get('available', True))
                    print(f"[PromptExtractor] {node_type} embedded data stack {stack_label}: "
                          f"{len(chain_loras_list)} LoRAs ({active_count} active, {avail_count} available)")
                    lora_chains.append({
                        'titles': [title or node_type],
                        'loras': chain_loras_list,
                        'terminal_title': title or node_type,
                        'source_id': node_id,
                        '_pm_stack': stack_label
                    })

            # Extract model info
            ext_model_a = ext_data.get('model_a', '').strip()
            ext_model_b = ext_data.get('model_b', '').strip()
            if ext_model_a:
                _pe_extracted_models.append(('a', ext_model_a, title or node_type))
            if ext_model_b:
                _pe_extracted_models.append(('b', ext_model_b, title or node_type))

    # ========================================
    # UNIFIED LORA CHAIN EXTRACTION
    # ========================================
    # Find all LoRA chains by starting from terminal nodes (non-LoRA nodes that receive MODEL input)
    # and traversing backwards through MODEL connections

    processed_terminals = set()  # Track by (terminal_id, input_name) tuple to allow multiple inputs per node

    if workflow_data:
        # Method 1: Find chains ending at non-LoRA nodes (MODEL input chains)
        terminals = find_lora_chain_terminals(workflow_data, node_map, link_map)
        print(f"[PromptExtractor] Found {len(terminals)} terminal nodes for LoRA chains")

        for terminal_info in terminals:
            terminal_id = terminal_info['terminal_id']
            input_name = terminal_info.get('input_name', '')
            source_id = terminal_info['lora_source_id']

            # Track by (terminal_id, input_name) to allow same terminal with multiple model inputs
            terminal_key = (terminal_id, input_name)
            if terminal_key in processed_terminals:
                continue

            # Collect all LoRAs in this chain
            chain_loras, chain_titles = collect_lora_model_chain(source_id, node_map, link_map)

            if chain_loras:
                active_count = sum(1 for lora in chain_loras if lora.get('active', True))
                inactive_count = len(chain_loras) - active_count
                lora_names_in_chain = [lora.get('name', 'unknown') for lora in chain_loras if lora.get('active', True)]
                print(f"[PromptExtractor] Chain from terminal {terminal_id} ({terminal_info.get('terminal_title', '')}), input '{input_name}': {active_count} active, {inactive_count} inactive LoRAs")
                print(f"[PromptExtractor]   Active LoRAs: {lora_names_in_chain}")
                print(f"[PromptExtractor]   Chain titles: {chain_titles}")
                print(f"[PromptExtractor]   Input label: {terminal_info.get('input_label', '')}")

            # Mark this terminal input as processed
            processed_terminals.add(terminal_key)

            if chain_loras:
                lora_chains.append({
                    'titles': chain_titles,
                    'loras': chain_loras,
                    'terminal_title': terminal_info.get('terminal_title', ''),
                    'terminal_id': terminal_id,
                    'source_id': source_id,
                    'input_name': terminal_info.get('input_name', ''),
                    'input_label': terminal_info.get('input_label', '')
                })

        # Method 2: Find LORA_STACK chains (for Lora Stacker nodes)
        lora_stacker_types = [
            'Lora Stacker (LoraManager)',
            'LoRA Stacker',
            'LoraStacker',
            'LoRA Stacker (LoRA Manager)'
        ]

        stacker_nodes = {}
        for node in all_workflow_nodes:
            if node.get('type') in lora_stacker_types:
                stacker_nodes[node.get('id')] = node

        # Find stackers feeding other stackers
        stackers_feeding_stackers = set()
        for node in all_workflow_nodes:
            if node.get('type') in lora_stacker_types:
                for inp in node.get('inputs', []):
                    if inp.get('name') == 'lora_stack' and inp.get('link'):
                        link_info = link_map.get(inp['link'])
                        if link_info and link_info['source_node'] in stacker_nodes:
                            stackers_feeding_stackers.add(link_info['source_node'])

        # Terminal stackers - but only include them if their output is actually connected
        terminal_stackers = [nid for nid in stacker_nodes.keys() if nid not in stackers_feeding_stackers]

        for terminal_id in terminal_stackers:
            node = stacker_nodes[terminal_id]

            # Check if this stacker's output is actually connected to something
            # A disconnected stacker should not be included
            outputs = node.get('outputs', [])
            has_connected_output = False
            for output in outputs:
                # Check if any link exists from this output
                if output.get('links') and len(output.get('links', [])) > 0:
                    has_connected_output = True
                    break

            # Skip this stacker if it's not connected to anything
            if not has_connected_output:
                continue

            chain_loras, chain_titles = collect_lora_stack_chain(terminal_id, node_map, link_map)

            if chain_loras:
                lora_chains.append({
                    'titles': chain_titles,
                    'loras': chain_loras,
                    'terminal_title': node.get('title', ''),
                    'source_id': terminal_id
                })

        # Method 3: Extract LoRAs from PromptManagerAdvanced nodes
        # These store LoRA data in the saved prompt JSON file, keyed by category/name
        _pm_prompts_cache = None
        for node in all_workflow_nodes:
            if node.get('type') != 'PromptManagerAdvanced':
                continue

            wv = node.get('widgets_values', [])
            if len(wv) < 6:
                continue

            pm_category = wv[0] if isinstance(wv[0], str) else None
            pm_name = wv[1] if isinstance(wv[1], str) else None
            pm_swap = wv[5] if len(wv) > 5 else False

            if not pm_category or not pm_name:
                continue

            # Load prompt data from disk (cached)
            if _pm_prompts_cache is None:
                try:
                    pm_data_path = os.path.join(folder_paths.get_user_directory(), "default", "prompt_manager_data.json")
                    if os.path.exists(pm_data_path):
                        with open(pm_data_path, 'r', encoding='utf-8') as f:
                            _pm_prompts_cache = json.load(f)
                    else:
                        _pm_prompts_cache = {}
                except Exception as e:
                    print(f"[PromptExtractor] Could not load prompt manager data: {e}")
                    _pm_prompts_cache = {}

            prompt_entry = _pm_prompts_cache.get(pm_category, {}).get(pm_name, {})
            pm_loras_a = prompt_entry.get('loras_a', [])
            pm_loras_b = prompt_entry.get('loras_b', [])

            if pm_swap:
                pm_loras_a, pm_loras_b = pm_loras_b, pm_loras_a

            node_title = node.get('title', f'PromptManagerAdvanced ({pm_name})')

            for stack_label, pm_loras in [('A', pm_loras_a), ('B', pm_loras_b)]:
                if not pm_loras:
                    continue
                chain_loras_list = []
                for lora_item in pm_loras:
                    if not isinstance(lora_item, dict):
                        continue
                    lora_name = lora_item.get('name', '')
                    if not lora_name:
                        continue
                    if lora_item.get('active', True) is False:
                        continue
                    if is_lora_blacklisted(lora_name):
                        continue
                    strength = float(lora_item.get('strength', 1.0))
                    clip_strength = float(lora_item.get('clip_strength', strength))
                    chain_loras_list.append({
                        'name': lora_name,
                        'path': lora_name,
                        'model_strength': strength,
                        'clip_strength': clip_strength,
                        'active': True
                    })

                if chain_loras_list:
                    # Use explicit stack assignment marker in title
                    stack_title = f"{node_title} [stack_{stack_label.lower()}]"
                    print(f"[PromptExtractor] PromptManagerAdvanced '{pm_name}' stack {stack_label}: {len(chain_loras_list)} LoRAs")
                    lora_chains.append({
                        'titles': [stack_title],
                        'loras': chain_loras_list,
                        'terminal_title': stack_title,
                        'source_id': node.get('id', 0),
                        '_pm_stack': stack_label  # Direct stack assignment marker
                    })

    # ========================================
    # ASSIGN LORA CHAINS TO STACKS A AND B
    # ========================================
    # Based on title hints (high/low) or position

    lora_chains.sort(key=lambda x: x.get('source_id', 0))

    print(f"[PromptExtractor] Processing {len(lora_chains)} chains for stack assignment")
    for i, chain in enumerate(lora_chains):
        # Direct stack assignment from PromptManagerAdvanced nodes
        pm_stack = chain.get('_pm_stack')
        if pm_stack:
            target_stack = loras_a if pm_stack == 'A' else loras_b
            target_seen = lora_names_seen_a if pm_stack == 'A' else lora_names_seen_b
            print(f"[PromptExtractor] Chain {i} → STACK {pm_stack} (PromptManagerAdvanced direct assignment)")
            for lora in chain['loras']:
                if lora['name'] not in target_seen:
                    target_seen.add(lora['name'])
                    target_stack.append(lora)
            continue

        # Check ALL titles in the chain for high/low hints
        all_titles = chain.get('titles', []) + [chain.get('terminal_title', '')]
        all_titles_lower = ' '.join(all_titles).lower()

        # ALSO check the input_name and input_label which are the most reliable indicators
        input_name = chain.get('input_name', '').lower()
        input_label = chain.get('input_label', '').lower()

        # IMPORTANT: Only check ACTIVE loras for the chain assignment
        active_loras = [lora for lora in chain.get('loras', []) if lora.get('active', True)]

        print(f"[PromptExtractor] Chain {i}: {len(chain.get('loras', []))} total LoRAs, {len(active_loras)} active")
        print(f"  Titles: {all_titles}")
        print(f"  Active LoRA names: {[lora.get('name', '') for lora in active_loras]}")

        # PRIORITY 1: Check CHAIN STRUCTURE (most reliable)
        # Use word boundaries to match complete words in titles and input names
        chain_has_high = (
            re.search(r'\bhigh\b', all_titles_lower) or
            re.search(r'\bhigh\b', input_name) or
            re.search(r'\bhigh\b', input_label) or
            'highnoise' in all_titles_lower.replace('_', '').replace('-', '').replace(' ', '')
        )
        chain_has_low = (
            re.search(r'\blow\b', all_titles_lower) or
            re.search(r'\blow\b', input_name) or
            re.search(r'\blow\b', input_label) or
            'lownoise' in all_titles_lower.replace('_', '').replace('-', '').replace(' ', '')
        )

        # PRIORITY 2: Check LoRA filenames with MAJORITY VOTING (fallback when chain structure unclear)
        # Count how many LoRAs have high/low indicators (excluding blacklisted LoRAs)
        high_count = 0
        low_count = 0
        for lora in active_loras:
            lora_name = lora.get('name', '')
            # Skip blacklisted LoRAs from voting
            if is_lora_blacklisted(lora_name):
                continue
            lora_name_lower = lora_name.lower()
            has_high_pattern = (
                '_high' in lora_name_lower or
                '-high' in lora_name_lower or
                'high_' in lora_name_lower or
                '_h.' in lora_name_lower or
                '_h_' in lora_name_lower
            )
            has_low_pattern = (
                '_low' in lora_name_lower or
                '-low' in lora_name_lower or
                'low_' in lora_name_lower or
                '_l.' in lora_name_lower or
                '_l_' in lora_name_lower
            )
            if has_high_pattern:
                high_count += 1
            if has_low_pattern:
                low_count += 1
                low_count += 1

        # Combine: Chain structure takes priority, filenames used as tiebreaker
        has_high = chain_has_high or (not chain_has_low and high_count > low_count)
        has_low = chain_has_low or (not chain_has_high and low_count > high_count)

        print(f"  Chain structure: high={chain_has_high}, low={chain_has_low}")
        print(f"  LoRA filename voting: {high_count} high, {low_count} low")
        print(f"  Final decision: has_high={has_high}, has_low={has_low}")

        # Determine which stack based on title hints
        if has_high and not has_low:
            print(f"[PromptExtractor] Chain {i} → STACK A (high detected in chain structure)")
            for lora in chain['loras']:
                # Only add active LoRAs
                if not lora.get('active', True):
                    continue
                # Skip blacklisted LoRAs
                if is_lora_blacklisted(lora['name']):
                    print(f"  Skipping blacklisted LoRA: {lora['name']}")
                    continue
                if lora['name'] not in lora_names_seen_a:
                    lora_names_seen_a.add(lora['name'])
                    loras_a.append(lora)
        elif has_low and not has_high:
            print(f"[PromptExtractor] Chain {i} → STACK B (low detected in chain structure)")
            for lora in chain['loras']:
                # Only add active LoRAs
                if not lora.get('active', True):
                    continue
                # Skip blacklisted LoRAs
                if is_lora_blacklisted(lora['name']):
                    print(f"  Skipping blacklisted LoRA: {lora['name']}")
                    continue
                if lora['name'] not in lora_names_seen_b:
                    lora_names_seen_b.add(lora['name'])
                    loras_b.append(lora)
        elif i == 0:
            # First chain defaults to A
            print(f"[PromptExtractor] Chain {i} → STACK A (first chain default, has_high={has_high}, has_low={has_low})")
            for lora in chain['loras']:
                # Only add active LoRAs
                if not lora.get('active', True):
                    continue
                # Skip blacklisted LoRAs
                if is_lora_blacklisted(lora['name']):
                    print(f"  Skipping blacklisted LoRA: {lora['name']}")
                    continue
                if lora['name'] not in lora_names_seen_a:
                    lora_names_seen_a.add(lora['name'])
                    loras_a.append(lora)
        elif i == 1:
            # Second chain defaults to B
            print(f"[PromptExtractor] Chain {i} → STACK B (second chain default, has_high={has_high}, has_low={has_low})")
            for lora in chain['loras']:
                # Only add active LoRAs
                if not lora.get('active', True):
                    continue
                # Skip blacklisted LoRAs
                if is_lora_blacklisted(lora['name']):
                    print(f"  Skipping blacklisted LoRA: {lora['name']}")
                    continue
                if lora['name'] not in lora_names_seen_b:
                    lora_names_seen_b.add(lora['name'])
                    loras_b.append(lora)
        else:
            # Additional chains go to A
            print(f"[PromptExtractor] Chain {i} → STACK A (additional chain default, has_high={has_high}, has_low={has_low})")
            for lora in chain['loras']:
                # Only add active LoRAs
                if not lora.get('active', True):
                    continue
                # Skip blacklisted LoRAs
                if is_lora_blacklisted(lora['name']):
                    print(f"  Skipping blacklisted LoRA: {lora['name']}")
                    continue
                if lora['name'] not in lora_names_seen_a:
                    lora_names_seen_a.add(lora['name'])
                    loras_a.append(lora)

    # Also iterate through prompt_data format (API format)
    # BUT: Only extract LoRAs from API format if we didn't already get them from workflow chains
    skip_api_lora_extraction = len(lora_chains) > 0

    for node_id, node_data in data.items():
        if not isinstance(node_data, dict):
            continue

        class_type = node_data.get('class_type', '')
        inputs = node_data.get('inputs', {})

        # Extract prompts from various node types (API format has direct text values)
        if class_type in ['CLIPTextEncode', 'CLIPTextEncodeSDXL', 'CLIPTextEncodeFlux']:
            text = inputs.get('text', '')
            if text and isinstance(text, str):
                # Determine if this is positive or negative by checking connections
                connection_type = None
                if node_map:
                    actual_node_id = int(node_id) if str(node_id).isdigit() else node_id
                    connection_type = determine_clip_text_encode_type(actual_node_id, workflow_data, node_map)

                # Fallback: check node title if we have node_map
                if not connection_type and node_map:
                    node = node_map.get(actual_node_id)
                    if node:
                        title_lower = node.get('title', '').lower()
                        if 'negative' in title_lower:
                            connection_type = 'negative'
                        elif 'positive' in title_lower:
                            connection_type = 'positive'

                # Add to appropriate list (default to positive if unclear)
                if connection_type == 'negative':
                    negative_prompts.append(text)
                else:
                    positive_prompts.append(text)

        # PromptManager nodes (always positive)
        elif class_type == 'PromptManager':
            text = inputs.get('text', '')
            if text and isinstance(text, str):
                positive_prompts.append(text)

        elif class_type == 'PromptManagerAdvanced':
            text = inputs.get('text', '')
            if text and isinstance(text, str):
                positive_prompts.append(text)

            # Extract LoRAs from toggle data (API format has these as JSON strings)
            pm_swap = inputs.get('swap_lora_outputs', False)
            for stack_key, stack_label in [('loras_a_toggle', 'A'), ('loras_b_toggle', 'B')]:
                toggle_raw = inputs.get(stack_key, '')
                if not toggle_raw or not isinstance(toggle_raw, str):
                    continue
                try:
                    toggle_list = json.loads(toggle_raw)
                except (json.JSONDecodeError, TypeError):
                    continue
                if not isinstance(toggle_list, list):
                    continue

                # Determine actual stack after swap
                actual_label = stack_label
                if pm_swap:
                    actual_label = 'B' if stack_label == 'A' else 'A'
                target_stack = loras_a if actual_label == 'A' else loras_b
                target_seen = lora_names_seen_a if actual_label == 'A' else lora_names_seen_b

                for lora_item in toggle_list:
                    if not isinstance(lora_item, dict):
                        continue
                    lora_name = lora_item.get('name', '')
                    if not lora_name or lora_item.get('active', True) is False:
                        continue
                    if is_lora_blacklisted(lora_name):
                        continue
                    if lora_name not in target_seen:
                        target_seen.add(lora_name)
                        strength = float(lora_item.get('strength', 1.0))
                        clip_strength = float(lora_item.get('clip_strength', strength))
                        target_stack.append({
                            'name': lora_name,
                            'path': lora_name,
                            'model_strength': strength,
                            'clip_strength': clip_strength
                        })

        # Standard LoRA loaders (API format)
        # Skip this if we already extracted LoRAs from workflow chains
        elif class_type in ['LoraLoader', 'LoraLoaderModelOnly'] and not skip_api_lora_extraction:
            # Check if this node's MODEL output is connected
            if node_map:
                node = node_map.get(int(node_id) if str(node_id).isdigit() else node_id)
                if node:
                    outputs = node.get('outputs', [])
                    has_connected_output = False
                    for output in outputs:
                        if output.get('type') == 'MODEL':
                            links = output.get('links')
                            if links and isinstance(links, list) and len(links) > 0:
                                has_connected_output = True
                                break
                    if not has_connected_output:
                        continue  # Skip disconnected nodes

            lora_name = inputs.get('lora_name', '')
            if lora_name and lora_name not in lora_names_seen_a:
                # Skip blacklisted LoRAs
                lora_basename = os.path.splitext(os.path.basename(lora_name))[0]
                if is_lora_blacklisted(lora_basename):
                    continue
                lora_names_seen_a.add(lora_name)
                model_strength = float(inputs.get('strength_model', inputs.get('strength', 1.0)))
                clip_strength = float(inputs.get('strength_clip', model_strength))
                loras_a.append({
                    'name': lora_basename,
                    'path': lora_name,
                    'model_strength': model_strength,
                    'clip_strength': clip_strength
                })

    # ========================================
    # GRAPH-TRAVERSAL PASS (API / prompt-dict format)
    # ========================================
    # Run the sampler-anchored recursive traversal when:
    #   • We are working from prompt_data (execution graph), AND
    #   • The standard iteration above did not yet find prompts.
    #
    # This handles custom nodes (Prompt Verify, TextMultiline, etc.) and
    # chained pipelines where the text never lands directly in a
    # CLIPTextEncode.inputs["text"] string.
    if data and (not positive_prompts or not negative_prompts):
        try:
            gt_pos, gt_neg = _extract_prompts_via_graph_traversal(data)
            if gt_pos and not positive_prompts:
                print(f"{TAG} [graph-traversal] Using traversal positive prompt ({len(gt_pos)} chars)")
                positive_prompts.append(gt_pos)
            if gt_neg and not negative_prompts:
                print(f"{TAG} [graph-traversal] Using traversal negative prompt ({len(gt_neg)} chars)")
                negative_prompts.append(gt_neg)
        except Exception as _gt_err:
            print(f"{TAG} [graph-traversal] Error during traversal (non-fatal): {_gt_err}")

    # Also check for LoRA syntax in prompts: <lora:name:strength>
    # Skip this if we already extracted LoRAs from workflow chains
    if not skip_api_lora_extraction:
        all_prompts = ' '.join(positive_prompts + negative_prompts)
        lora_pattern = r'<lora:([^:>]+):([^:>]+)(?::([^>]+))?>'
        for match in re.finditer(lora_pattern, all_prompts):
            lora_name = match.group(1).strip()
            # Skip blacklisted LoRAs
            if is_lora_blacklisted(lora_name):
                continue
            if lora_name not in lora_names_seen_a:
                lora_names_seen_a.add(lora_name)
                model_strength = float(match.group(2)) if match.group(2) else 1.0
                clip_strength = float(match.group(3)) if match.group(3) else model_strength
                loras_a.append({
                    'name': lora_name,
                    'path': '',
                    'model_strength': model_strength,
                    'clip_strength': clip_strength
                })

    # Embedded prompt text is fallback-only. Prefer prompts extracted from
    # execution metadata/workflow graph first to avoid stale node UI state.
    if not positive_prompts and _embedded_positive_fallback:
        positive_prompts.extend(_embedded_positive_fallback)
    if not negative_prompts and _embedded_negative_fallback:
        negative_prompts.extend(_embedded_negative_fallback)

    # Clean LoRA syntax from prompts (even if we skipped extraction, we still clean the syntax)
    lora_pattern = r'<lora:([^:>]+):([^:>]+)(?::([^>]+))?>'
    clean_positive = []
    for p in positive_prompts:
        cleaned = re.sub(lora_pattern, '', p).strip()
        cleaned = re.sub(r'\s+', ' ', cleaned)  # Collapse multiple spaces
        if cleaned:
            clean_positive.append(cleaned)

    clean_negative = []
    for p in negative_prompts:
        cleaned = re.sub(lora_pattern, '', p).strip()
        cleaned = re.sub(r'\s+', ' ', cleaned)
        if cleaned:
            clean_negative.append(cleaned)

    # Guard against duplicate prompt chunks when metadata provides both
    # workflow-node and API-node representations of the same text.
    def _dedupe_prompt_chunks(chunks):
        seen = set()
        out = []
        for chunk in chunks:
            key = re.sub(r'\s+', ' ', str(chunk or '')).strip()
            if not key:
                continue
            if key in seen:
                continue
            seen.add(key)
            out.append(key)
        return out

    clean_positive = _dedupe_prompt_chunks(clean_positive)
    clean_negative = _dedupe_prompt_chunks(clean_negative)

    # Use the first prompt from each list (our connection logic already determined which is which)
    # If multiple prompts exist, concatenate them with commas
    result['positive_prompt'] = ', '.join(clean_positive) if clean_positive else ''
    result['negative_prompt'] = ', '.join(clean_negative) if clean_negative else ''
    result['loras_a'] = loras_a
    result['loras_b'] = loras_b

    # ========================================
    # MODEL / CHECKPOINT EXTRACTION
    # ========================================
    # Find model loaders (CheckpointLoader*, UNETLoader, etc.) and assign to A/B
    # using the same high/low chain logic as LoRAs.
    #
    # Strategy:
    # 1. Find model loaders that are at the root of LoRA chains (already traced)
    # 2. Find model loaders connected directly to KSamplers (no LoRAs in chain)
    # 3. Find standalone model loaders from API format
    # 4. Assign to A (high/first) or B (low/second) based on chain context

    models_a = []
    models_b = []
    model_names_seen = set()

    if workflow_data and node_map:
        # Approach: trace each KSampler/terminal MODEL input back to its model loader
        # and use the terminal's high/low context for assignment
        model_input_names = [
            'model', 'MODEL',
            'model_high_noise', 'model_low_noise',
            'base_model', 'refiner_model',
            'unet',
        ]

        for node in all_workflow_nodes:
            node_id = node.get('id')
            node_type = node.get('type', '')

            # Skip LoRA loaders and model loaders themselves
            if is_lora_node(node_type) or is_model_loader_node(node_type):
                continue

            inputs = node.get('inputs', [])
            for inp in inputs:
                inp_name = inp.get('name', '')
                inp_type = inp.get('type', '')
                is_model_input = (inp_type == 'MODEL' or inp_name in model_input_names)

                if is_model_input and inp.get('link'):
                    link_info = link_map.get(inp['link'])
                    if not link_info:
                        continue

                    # Trace back through the chain to find the model loader
                    loader_id = trace_to_model_loader(link_info['source_node'], node_map, link_map)
                    if not loader_id:
                        continue

                    loader_node = node_map.get(loader_id)
                    if not loader_node:
                        continue

                    loader_type = loader_node.get('type', '')
                    prompt_node = data.get(str(loader_id))

                    # Special handling for CyberdyneModelHub which outputs high/low from different slots
                    if loader_type == 'CyberdyneModelHub':
                        inputs_api = prompt_node.get('inputs', {}) if prompt_node else {}
                        high_name = inputs_api.get('model_high_name')
                        low_name = inputs_api.get('model_low_name')
                        if high_name and isinstance(high_name, str) and high_name not in model_names_seen:
                            model_names_seen.add(high_name)
                            print(f"[PromptExtractor] Model → A (high, CyberdyneModelHub): {high_name}")
                            models_a.append(high_name)
                        if low_name and isinstance(low_name, str) and low_name not in model_names_seen:
                            model_names_seen.add(low_name)
                            print(f"[PromptExtractor] Model → B (low, CyberdyneModelHub): {low_name}")
                            models_b.append(low_name)
                        continue

                    # Get model name - prefer API format (prompt_data) for active nodes
                    model_name = get_model_name_from_node(loader_node, prompt_node)
                    if not model_name or model_name in model_names_seen:
                        continue

                    model_names_seen.add(model_name)

                    # Determine high/low assignment from context
                    inp_label = inp.get('label', '').lower()
                    inp_name_lower = inp_name.lower()
                    terminal_title = node.get('title', '').lower()
                    loader_title = loader_node.get('title', '').lower()
                    model_name_lower = model_name.lower()

                    # Check all available context for high/low indicators
                    all_context = f"{inp_label} {inp_name_lower} {terminal_title} {loader_title} {model_name_lower}"
                    all_context_compact = all_context.replace('_', '').replace('-', '').replace(' ', '')

                    has_high = bool(
                        re.search(r'\bhigh\b', all_context) or
                        re.search(r'high(?:noise|_noise)', all_context_compact) or
                        re.search(r'i2v\s*high|t2v\s*high|_high|high_', all_context) or
                        re.search(r'high', model_name_lower)
                    )
                    has_low = bool(
                        re.search(r'\blow\b', all_context) or
                        re.search(r'low(?:noise|_noise)', all_context_compact) or
                        re.search(r'i2v\s*low|t2v\s*low|_low|low_', all_context) or
                        re.search(r'low', model_name_lower)
                    )

                    if has_low and not has_high:
                        print(f"[PromptExtractor] Model → B (low): {model_name}")
                        models_b.append(model_name)
                    else:
                        print(f"[PromptExtractor] Model → A (high/default): {model_name}")
                        models_a.append(model_name)

    # Fallback: extract from API format if workflow traversal found nothing
    if not models_a and not models_b and data:
        for node_id_str, node_data in data.items():
            if not isinstance(node_data, dict):
                continue
            class_type = node_data.get('class_type', '')
            if class_type not in MODEL_LOADER_TYPES:
                continue

            inputs = node_data.get('inputs', {})

            # Special handling for CyberdyneModelHub which has high/low in one node
            if class_type == 'CyberdyneModelHub':
                high_name = inputs.get('model_high_name')
                low_name = inputs.get('model_low_name')
                if high_name and isinstance(high_name, str) and high_name not in model_names_seen:
                    model_names_seen.add(high_name)
                    print(f"[PromptExtractor] Model → A (high, CyberdyneModelHub): {high_name}")
                    models_a.append(high_name)
                if low_name and isinstance(low_name, str) and low_name not in model_names_seen:
                    model_names_seen.add(low_name)
                    print(f"[PromptExtractor] Model → B (low, CyberdyneModelHub): {low_name}")
                    models_b.append(low_name)
                continue

            model_name = None
            for key in ['ckpt_name', 'unet_name', 'model_name', 'diffusion_model', 'model', 'model_path']:
                val = inputs.get(key)
                if val and isinstance(val, str):
                    model_name = val
                    break

            if not model_name or model_name in model_names_seen:
                continue

            model_names_seen.add(model_name)
            model_name_lower = model_name.lower()

            has_low = bool(
                'low_noise' in model_name_lower or '_low' in model_name_lower or
                re.search(r'i2v\s*low|t2v\s*low|low_', model_name_lower) or
                re.search(r'low', model_name_lower)
            )
            has_high = bool(
                'high_noise' in model_name_lower or '_high' in model_name_lower or
                re.search(r'i2v\s*high|t2v\s*high|high_', model_name_lower) or
                re.search(r'high', model_name_lower)
            )

            if has_low and not has_high:
                print(f"[PromptExtractor] Model → B (low, API fallback): {model_name}")
                models_b.append(model_name)
            else:
                print(f"[PromptExtractor] Model → A (high/default, API fallback): {model_name}")
                models_a.append(model_name)

    result['models_a'] = models_a
    result['models_b'] = models_b

    # Add models from PromptExtractor embedded data (if no models found from other sources)
    if _pe_extracted_models and not models_a and not models_b:
        for stack, model_path, source in _pe_extracted_models:
            if stack == 'a':
                print(f"[PromptExtractor] Model → A (from embedded PromptExtractor data): {model_path}")
                models_a.append(model_path)
            elif stack == 'b':
                print(f"[PromptExtractor] Model → B (from embedded PromptExtractor data): {model_path}")
                models_b.append(model_path)

    return result




def convert_workflow_to_prompt_format(workflow_data):
    """Convert workflow format (nodes array) to prompt format (node_id: data dict), including subgraph nodes"""
    if not isinstance(workflow_data, dict):
        return {}

    result = {}

    # Collect all nodes (top-level + subgraphs)
    all_nodes = []

    # Add top-level nodes
    if 'nodes' in workflow_data:
        all_nodes.extend(workflow_data.get('nodes', []))

    # Add nodes from subgraph definitions
    if 'definitions' in workflow_data and 'subgraphs' in workflow_data['definitions']:
        for subgraph in workflow_data['definitions']['subgraphs']:
            if 'nodes' in subgraph:
                all_nodes.extend(subgraph['nodes'])

    for node in all_nodes:
        if not isinstance(node, dict):
            continue

        node_id = str(node.get('id', ''))
        if not node_id:
            continue

        class_type = node.get('type', '')
        widgets_values = node.get('widgets_values', [])

        # Map widgets_values to inputs based on node type
        inputs = {}

        if class_type in ['CLIPTextEncode', 'CLIPTextEncodeSDXL']:
            if widgets_values:
                inputs['text'] = widgets_values[0] if widgets_values else ''

        elif class_type in ['LoraLoader', 'LoraLoaderModelOnly']:
            if len(widgets_values) >= 1:
                inputs['lora_name'] = widgets_values[0]
            if len(widgets_values) >= 2:
                inputs['strength_model'] = widgets_values[1]
            if len(widgets_values) >= 3:
                inputs['strength_clip'] = widgets_values[2]

        elif class_type in ['PromptManager', 'PromptManagerAdvanced']:
            # Find text widget value
            for val in widgets_values:
                if isinstance(val, str) and len(val) > 20:  # Likely the prompt text
                    inputs['text'] = val
                    break

        elif class_type in ['CheckpointLoaderSimple', 'CheckpointLoader', 'CheckpointLoaderKJ', 'CheckpointLoaderNF4']:
            if widgets_values:
                inputs['ckpt_name'] = widgets_values[0]

        elif class_type in ['UNETLoader', 'UnetLoaderGGUF', 'DiffusionModelLoader']:
            if widgets_values:
                inputs['unet_name'] = widgets_values[0]

        elif class_type == 'DiffusionModelLoaderKJ':
            if widgets_values:
                inputs['model_name'] = widgets_values[0]

        elif class_type == 'WanVideoModelLoader':
            if widgets_values:
                inputs['model'] = widgets_values[0]

        elif class_type == 'SeaArtUnetLoader':
            if widgets_values:
                inputs['unet_name'] = widgets_values[0]

        elif class_type == 'CyberdyneModelHub':
            if len(widgets_values) >= 1:
                inputs['model_high_name'] = widgets_values[0]
            if len(widgets_values) >= 3:
                inputs['model_low_name'] = widgets_values[2]

        result[node_id] = {
            'class_type': class_type,
            'inputs': inputs
        }

    return result


def load_image_as_tensor(file_path):
    """Load an image file and convert to ComfyUI tensor format (B, H, W, C) as torch tensor"""
    if not IMAGE_SUPPORT:
        return None

    try:
        img = Image.open(file_path)
        # Convert to RGB if needed
        if img.mode != 'RGB':
            img = img.convert('RGB')

        # Convert to numpy array and normalize to 0-1
        img_array = np.array(img).astype(np.float32) / 255.0

        # Convert to torch tensor with batch dimension (B, H, W, C)
        img_tensor = torch.from_numpy(img_array).unsqueeze(0)

        return img_tensor
    except Exception as e:
        print(f"[PromptExtractor] Error loading image: {e}")
        return None


def get_placeholder_image_tensor():
    """Load the placeholder PNG as a tensor for display when no image is available"""
    if not IMAGE_SUPPORT:
        return torch.zeros((1, 128, 128, 3), dtype=torch.float32)

    try:
        # Get the path to placeholder.png relative to this file
        package_dir = os.path.dirname(os.path.abspath(__file__))
        png_path = os.path.join(package_dir, 'web', 'placeholder.png')

        if os.path.exists(png_path):
            return load_image_as_tensor(png_path)
    except Exception as e:
        print(f"[PromptExtractor] Could not load placeholder PNG: {e}")

    # Fallback: create a simple gray placeholder
    img_array = np.full((128, 128, 3), 42 / 255.0, dtype=np.float32)
    return torch.from_numpy(img_array).unsqueeze(0)


# ── API Endpoints ─────────────────────────────────────────────────────────────

@server.PromptServer.instance.routes.post("/meta-prompt-extractor/cache-file-metadata")
async def _cache_file_metadata(request):
    """Receive file metadata extracted by the JS frontend and cache it for Python execution."""
    try:
        data = await request.json()
        filename = data.get("filename")
        metadata = data.get("metadata")
        if not filename:
            return server.web.json_response({"success": False, "error": "Missing filename"}, status=400)
        if metadata:
            # Normalise to forward slashes so Windows paths match Python lookups
            norm_key = filename.replace("\\", "/").replace("\\", "/")
            _file_metadata_cache[norm_key] = metadata
            print(f"{TAG} Cached metadata key: {norm_key}")
        return server.web.json_response({"success": True})
    except Exception as e:
        return server.web.json_response({"success": False, "error": str(e)}, status=500)


@server.PromptServer.instance.routes.get("/meta-prompt-extractor/list-roots")
async def _list_filesystem_roots(request):
    """Return available filesystem roots."""
    try:
        roots = []
        if os.name == "nt":
            import string, ctypes
            bitmask = ctypes.windll.kernel32.GetLogicalDrives()
            for letter in string.ascii_uppercase:
                if bitmask & 1:
                    roots.append(f"{letter}:\\")
                bitmask >>= 1
        else:
            roots = ["/"]
        return server.web.json_response({"roots": roots})
    except Exception as e:
        return server.web.json_response({"roots": ["/"], "error": str(e)}, status=500)


def _check_file_has_metadata(file_path):
    """Check if a file has embedded metadata (prompt/workflow)."""
    try:
        ext = os.path.splitext(file_path)[1].lower()
        if ext not in ['.png', '.jpg', '.jpeg', '.webp', '.json']:
            return False
        
        # Check cache first
        cache_key = file_path.replace(os.sep, '/')
        if cache_key in _file_metadata_cache:
            return True
        
        # For images, try to detect metadata
        if ext in ['.png', '.jpg', '.jpeg', '.webp'] and IMAGE_SUPPORT:
            try:
                with Image.open(file_path) as img:
                    if ext == '.png':
                        return 'prompt' in img.info or 'workflow' in img.info
                    elif ext in ['.jpg', '.jpeg', '.webp']:
                        exif = img.getexif()
                        return bool(exif)
            except:
                pass
        
        # For JSON files, check if it contains workflow/prompt structure
        if ext == '.json':
            try:
                with open(file_path, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                    if isinstance(data, dict):
                        return bool(data.get('nodes') or data.get('prompt') or data.get('workflow'))
            except:
                pass
        
        return False
    except:
        return False


@server.PromptServer.instance.routes.get("/meta-prompt-extractor/browse")
async def _browse_filesystem(request):
    """List directory contents with detailed file info (size, mtime, metadata indicator)."""
    SUPPORTED = {".png", ".jpg", ".jpeg", ".webp", ".json"}
    IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp"}
    try:
        path = request.rel_url.query.get("path", "") or os.path.expanduser("~")
        path = os.path.normpath(path)
        if not os.path.isdir(path):
            return server.web.json_response({"error": "Not a directory"}, status=400)
        entries = []
        try:
            for name in sorted(os.listdir(path), key=lambda n: (not os.path.isdir(os.path.join(path, n)), n.lower())):
                full  = os.path.join(path, name)
                is_dir = os.path.isdir(full)
                ext   = os.path.splitext(name)[1].lower()
                if is_dir:
                    entries.append({"name": name, "path": full, "type": "dir"})
                elif ext in SUPPORTED:
                    # Get file stats
                    try:
                        stat = os.stat(full)
                        size = stat.st_size
                        mtime = stat.st_mtime  # Unix timestamp
                    except:
                        size = 0
                        mtime = 0
                    
                    # Check for metadata (async check would be better, but keep it simple for now)
                    has_metadata = _check_file_has_metadata(full)
                    is_image = ext in IMAGE_EXTS
                    
                    entries.append({
                        "name": name, 
                        "path": full, 
                        "type": "file", 
                        "ext": ext,
                        "size": size,
                        "mtime": mtime,
                        "has_metadata": has_metadata,
                        "is_image": is_image
                    })
        except PermissionError:
            pass
        parent = os.path.dirname(path)
        if parent == path:
            parent = None
        return server.web.json_response({"current": path, "parent": parent, "entries": entries})
    except Exception as e:
        return server.web.json_response({"error": str(e)}, status=500)


@server.PromptServer.instance.routes.get("/meta-prompt-extractor/serve-file")
async def _serve_file(request):
    """Serve any file by absolute path for JS preview / metadata extraction."""
    try:
        path = request.rel_url.query.get("path", "")
        if not path or not os.path.isabs(path):
            return server.web.Response(status=400, text="Absolute path required")
        path = os.path.normpath(path)
        if not os.path.isfile(path):
            return server.web.Response(status=404, text="File not found")
        mime, _ = mimetypes.guess_type(path)
        mime = mime or "application/octet-stream"
        with open(path, "rb") as fh:
            data = fh.read()
        return server.web.Response(body=data, content_type=mime, headers={
            "Cache-Control": "no-cache",
            "Content-Disposition": f'inline; filename="{os.path.basename(path)}"',
        })
    except Exception as e:
        return server.web.Response(status=500, text=str(e))


@server.PromptServer.instance.routes.post("/meta-prompt-extractor/open-in-explorer")
async def _open_in_explorer(request):
    """Open a folder in the system file explorer (Windows/macOS/Linux)."""
    try:
        data = await request.json()
        path = data.get("path", "")
        
        if not path:
            return server.web.json_response({"success": False, "error": "No path provided"}, status=400)
        
        path = os.path.normpath(path)
        
        # Verify path exists
        if not os.path.exists(path):
            return server.web.json_response({"success": False, "error": "Path does not exist"}, status=404)
        
        # If it's a file, get the parent directory
        if os.path.isfile(path):
            path = os.path.dirname(path)
        
        # Open in file explorer based on OS
        import platform
        import subprocess
        
        try:
            abs_path = os.path.abspath(path)
            if platform.system() == "Windows":
                # Windows: use explorer.exe with proper path quoting
                import subprocess
                subprocess.Popen(f'explorer "{abs_path}"', shell=True)
                print(f"[MetaPromptExtractor] Opened in Explorer: {abs_path}")
            elif platform.system() == "Darwin":
                # macOS: use open
                subprocess.Popen(["open", "-R", abs_path])
                print(f"[MetaPromptExtractor] Opened in Finder: {abs_path}")
            else:
                # Linux and others: use xdg-open
                subprocess.Popen(["xdg-open", abs_path])
                print(f"[MetaPromptExtractor] Opened in file manager: {abs_path}")
            
            return server.web.json_response({"success": True, "message": f"Opened: {abs_path}"})
        except Exception as e:
            print(f"[MetaPromptExtractor] Error opening explorer: {str(e)}")
            return server.web.json_response({"success": False, "error": f"Failed to open explorer: {str(e)}"}, status=500)
    except Exception as e:
        return server.web.json_response({"success": False, "error": str(e)}, status=500)


@server.PromptServer.instance.routes.get("/meta-prompt-extractor/open-file-dialog")
async def _open_file_dialog(request):
    """
    Open a native OS file-picker dialog (tkinter) and return the selected path.
    Runs the blocking tkinter call in a thread pool so the server stays responsive.
    Supports Windows, macOS, and Linux (requires a display on Linux).
    """
    import asyncio
    import concurrent.futures

    # File types the node supports
    FILETYPES = [
        ("Supported files",
         "*.png *.jpg *.jpeg *.webp *.json"),
        ("Images",      "*.png *.jpg *.jpeg *.webp"),
        ("JSON workflows", "*.json"),
        ("All files",   "*.*"),
    ]

    # Optional: start in the directory of the currently selected file
    initial_dir = request.rel_url.query.get("initial_dir", "") or os.path.expanduser("~")
    if not os.path.isdir(initial_dir):
        initial_dir = os.path.expanduser("~")

    def _show_dialog():
        try:
            import tkinter as tk
            from tkinter import filedialog
            root = tk.Tk()
            root.withdraw()          # hide the root window
            root.wm_attributes("-topmost", True)   # bring dialog to front
            path = filedialog.askopenfilename(
                parent=root,
                title="Select Image, Video, or Workflow JSON",
                initialdir=initial_dir,
                filetypes=FILETYPES,
            )
            root.destroy()
            return path or ""
        except Exception as e:
            print(f"{TAG} tkinter dialog error: {e}")
            return ""

    try:
        loop = asyncio.get_event_loop()
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            path = await loop.run_in_executor(pool, _show_dialog)

        if path:
            # Normalise to forward slashes for consistency
            path = path.replace("\\", "/")
            return server.web.json_response({"path": path, "cancelled": False})
        else:
            return server.web.json_response({"path": "", "cancelled": True})

    except Exception as e:
        print(f"{TAG} Error opening file dialog: {e}")
        return server.web.json_response(
            {"path": "", "cancelled": True, "error": str(e)},
            status=500
        )

@server.PromptServer.instance.routes.get("/meta-prompt-extractor/extract-preview-abs")
async def _extract_preview_abs(request):
    """
    Extract prompts from an absolute file path and return them as JSON.
    Used by the JS frontend for the live-preview indicator and RecipeBuilder.
    """
    try:
        file_path = request.rel_url.query.get("path", "")
        if not file_path or not os.path.isabs(file_path):
            return server.web.json_response({"extracted": None, "error": "Absolute path required"}, status=400)
        file_path = os.path.normpath(file_path)
        if not os.path.isfile(file_path):
            return server.web.json_response({"extracted": None, "error": "File not found"})

        ext = os.path.splitext(file_path)[1].lower()
        prompt_data  = None
        workflow_raw = None

        if ext == ".png":
            prompt_data, workflow_raw = extract_metadata_from_png(file_path)
        elif ext in (".jpg", ".jpeg", ".webp"):
            prompt_data, workflow_raw = extract_metadata_from_jpeg(file_path)
        elif ext == ".json":
            prompt_data, workflow_raw = extract_metadata_from_json(file_path)

        if not prompt_data and not workflow_raw:
            return server.web.json_response({"extracted": None, "error": "No metadata found"})

        parsed = parse_workflow_for_prompts(prompt_data, workflow_raw)
        positive = parsed.get("positive_prompt") or ""
        negative = parsed.get("negative_prompt") or ""

        return server.web.json_response({
            "extracted": {
                "positive_prompt": positive,
                "negative_prompt": negative,
            }
        })
    except Exception as e:
        print(f"{TAG} Error in extract-preview-abs: {e}")
        import traceback; traceback.print_exc()
        return server.web.json_response({"extracted": None, "error": str(e)}, status=500)


# ── ComfyUI Node Class ────────────────────────────────────────────────────────

class MetaPromptExtractor:
    """
    Extract positive and negative prompts from any image, video, or JSON
    workflow file on disk.  Accepts any absolute file path — use the
    📁 Browse button to navigate to any folder on any drive.

    Outputs:
        positive_prompt  — STRING
        negative_prompt  — STRING
        image            — IMAGE tensor (placeholder for JSON/missing files)
    """

    @classmethod
    def INPUT_TYPES(cls):
        # COMBO widget (list) is required — not STRING — so that LiteGraph
        # renders it as a proper widget object that JS can find via
        # widgets.find() and splice a button next to.  The Browse button
        # writes the chosen absolute path directly into this widget's value.
        # NOTE: COMBO must have at least 2 entries so ComfyUI renders it as
        # a widget rather than an input slot.
        return {
            "required": {
                "image": (["(none)", ""], {
                    "tooltip": "Absolute path to a file. Use the Browse button.",
                }),
            },
            "hidden": {
                "unique_id":    "UNIQUE_ID",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    CATEGORY    = "utils"
    DESCRIPTION = (
        "Extract positive and negative prompts from ComfyUI images "
        "or workflow JSON files stored anywhere on disk."
    )
    RETURN_TYPES  = ("STRING", "STRING", "IMAGE")
    RETURN_NAMES  = ("positive_prompt", "negative_prompt", "image")
    FUNCTION      = "extract"
    OUTPUT_NODE   = False

    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs):
        return True

    # ------------------------------------------------------------------
    def extract(self, image="", unique_id=None,
                extra_pnginfo=None, **kwargs):
        """Extract prompts from the specified image or JSON file."""
        positive_prompt = ""
        negative_prompt = ""
        image_tensor    = None

        file_path = (image or "").strip()
        if file_path in ("", "(none)"):
            return positive_prompt, negative_prompt, _placeholder_tensor()

        # Resolve path (absolute preferred; fall back to input dir)
        resolved = None
        if os.path.isabs(file_path):
            resolved = file_path if os.path.isfile(file_path) else None
        else:
            for base in (folder_paths.get_input_directory(),
                         folder_paths.get_output_directory(),
                         folder_paths.get_temp_directory()):
                candidate = os.path.join(base, file_path)
                if os.path.isfile(candidate):
                    resolved = candidate
                    break

        if not resolved:
            print(f"{TAG} File not found: {file_path}")
            return positive_prompt, negative_prompt, _placeholder_tensor()

        print(f"{TAG} Processing: {resolved}")
        ext = os.path.splitext(resolved)[1].lower()

        prompt_data  = None
        workflow_raw = None

        if ext == ".png":
            prompt_data, workflow_raw = extract_metadata_from_png(resolved)
            image_tensor = load_image_as_tensor(resolved)
        elif ext in (".jpg", ".jpeg", ".webp"):
            prompt_data, workflow_raw = extract_metadata_from_jpeg(resolved)
            image_tensor = load_image_as_tensor(resolved)
        elif ext == ".json":
            prompt_data, workflow_raw = extract_metadata_from_json(resolved)

        if prompt_data or workflow_raw:
            parsed          = parse_workflow_for_prompts(prompt_data, workflow_raw)
            positive_prompt = parsed.get("positive_prompt") or ""
            negative_prompt = parsed.get("negative_prompt") or ""
            print(f"{TAG} Extracted prompts — positive: {len(positive_prompt)} chars, "
                  f"negative: {len(negative_prompt)} chars")
        else:
            print(f"{TAG} No metadata found in: {resolved}")

        if image_tensor is None:
            image_tensor = _placeholder_tensor()

        return positive_prompt, negative_prompt, image_tensor

    @classmethod
    def IS_CHANGED(cls, image="", **kwargs):
        mtime = "no_file"
        if image and image.strip() not in ("", "(none)"):
            p = image.strip()
            if not os.path.isabs(p):
                p = os.path.join(folder_paths.get_input_directory(), p)
            if os.path.isfile(p):
                mtime = os.path.getmtime(p)
        return mtime


# ── Private helpers ───────────────────────────────────────────────────────────

def _placeholder_tensor():
    """1×128×128 gray tensor when no image is available."""
    if IMAGE_SUPPORT:
        arr = np.full((128, 128, 3), 42.0 / 255.0, dtype=np.float32)
        return torch.from_numpy(arr).unsqueeze(0)
    return torch.zeros((1, 128, 128, 3), dtype=torch.float32)
