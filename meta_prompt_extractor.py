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


def parse_a1111_parameters(parameters_text):
    """
    Parse A1111/Forge parameters format
    Returns dict with prompt and negative_prompt
    """
    if not parameters_text:
        return None

    result = {
        'prompt': '',
        'negative_prompt': ''
    }

    # Split by "Negative prompt:" to separate positive and negative
    parts = re.split(r'Negative prompt:\s*', parameters_text, flags=re.IGNORECASE)
    positive_prompt = parts[0].strip()
    remainder = parts[1] if len(parts) > 1 else ''

    # Remove LoRA tags from prompt
    lora_pattern = r'<lora:([^:>]+):([^:>]+)(?::([^:>]+))?>'
    positive_prompt = re.sub(lora_pattern, '', positive_prompt).strip()
    result['prompt'] = positive_prompt

    # Extract negative prompt (before any "Steps:" line if present)
    settings_match = re.match(r'^(.*?)[\r\n]+Steps:', remainder, re.DOTALL)
    if settings_match:
        result['negative_prompt'] = settings_match.group(1).strip()
    else:
        result['negative_prompt'] = remainder.strip()

    return result

# ─────────────────────────────────────────────────────────────────────────────
# Metadata normalisation helpers
# ─────────────────────────────────────────────────────────────────────────────
TAG_META = "[MetaPromptExtractor]"

def _coerce_to_dict(value, label="value"):
    if value is None:
        return None
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return None
        try:
            parsed = json.loads(stripped)
            if isinstance(parsed, dict):
                return parsed
            if isinstance(parsed, str):
                try:
                    inner = json.loads(parsed)
                    if isinstance(inner, dict):
                        return inner
                except Exception:
                    pass
            return None
        except json.JSONDecodeError:
            return None
    return None

def _get_workflow_data(metadata):
    if not metadata or not isinstance(metadata, dict):
        return None

    for key in ("workflow", "Workflow", "prompt", "Prompt"):
        raw = metadata.get(key)
        if raw is None:
            continue
        result = _coerce_to_dict(raw, label=f"metadata[{key!r}]")
        if result is not None:
            return result

    for key, raw in metadata.items():
        if not isinstance(raw, str):
            continue
        stripped = raw.strip()
        if not stripped.startswith("{"):
            continue
        try:
            parsed = json.loads(stripped)
        except json.JSONDecodeError:
            continue
        if not isinstance(parsed, dict):
            continue
        has_numeric     = any(str(k).isdigit() for k in parsed)
        has_nodes_array = "nodes" in parsed
        if has_numeric or has_nodes_array:
            return parsed

    return None

def _normalise_metadata_pair(prompt_data, workflow_data):
    if isinstance(prompt_data, str):
        prompt_data = _coerce_to_dict(prompt_data, "prompt_data string")
    if isinstance(workflow_data, str):
        workflow_data = _coerce_to_dict(workflow_data, "workflow_data string")

    for candidate, side in [(prompt_data, "prompt_data"),
                             (workflow_data, "workflow_data")]:
        if not isinstance(candidate, dict):
            continue
        inner_p = candidate.get("prompt") or candidate.get("Prompt")
        inner_w = candidate.get("workflow") or candidate.get("Workflow")
        if inner_p is not None or inner_w is not None:
            if inner_p is not None and candidate is prompt_data:
                prompt_data = (inner_p if isinstance(inner_p, dict)
                               else _coerce_to_dict(inner_p, "unwrapped prompt"))
            if inner_w is not None and (workflow_data is None
                                        or candidate is workflow_data):
                workflow_data = (inner_w if isinstance(inner_w, dict)
                                 else _coerce_to_dict(inner_w, "unwrapped workflow"))
            break

    if not isinstance(prompt_data, dict):
        prompt_data = None
    if not isinstance(workflow_data, dict):
        workflow_data = None

    return prompt_data, workflow_data

def extract_metadata_from_png(file_path):
    try:
        input_dir = folder_paths.get_input_directory()
        output_dir = folder_paths.get_output_directory()
        use_cache = True
        if file_path.startswith(input_dir):
            cache_key = os.path.relpath(file_path, input_dir).replace('\\', '/')
        elif file_path.startswith(output_dir):
            cache_key = os.path.relpath(file_path, output_dir).replace('\\', '/')
            use_cache = False
        else:
            cache_key = file_path.replace(os.sep, '/')
            use_cache = True

        if use_cache and cache_key in _file_metadata_cache:
            metadata = _file_metadata_cache[cache_key]

            if isinstance(metadata, dict):
                if metadata.get('parsed_parameters'):
                    parsed = metadata['parsed_parameters']
                    raw_params = metadata.get('parameters', '')
                    if raw_params:
                        py_parsed = parse_a1111_parameters(raw_params)
                        if py_parsed:
                            parsed['prompt'] = py_parsed.get('prompt', '')
                            parsed['negative_prompt'] = py_parsed.get('negative_prompt', '')
                    raw_wf = metadata.get('workflow') or metadata.get('Workflow')
                    workflow_data = _coerce_to_dict(raw_wf, "cached workflow alongside A1111")
                    return parsed, workflow_data

                workflow_data = _get_workflow_data(metadata)
                raw_prompt    = metadata.get('prompt') or metadata.get('Prompt')
                prompt_data   = (_coerce_to_dict(raw_prompt, "cached prompt")
                                 if raw_prompt is not None else None)

                if (workflow_data is not None
                        and 'nodes' not in workflow_data
                        and prompt_data is None
                        and any(str(k).isdigit() for k in workflow_data)):
                    prompt_data, workflow_data = workflow_data, None

                return prompt_data, workflow_data

        if not IMAGE_SUPPORT:
            return None, None

        with Image.open(file_path) as img:
            metadata = img.info

            raw_params = (metadata.get('parameters') or metadata.get('Parameters')
                          or metadata.get('Comment') or metadata.get('comment'))
            if isinstance(raw_params, str) and (
                    'Negative prompt:' in raw_params or '<lora:' in raw_params):
                parsed = parse_a1111_parameters(raw_params)
                if parsed:
                    workflow_json = _get_workflow_data(dict(metadata))
                    return parsed, workflow_json

            workflow_json = _get_workflow_data(dict(metadata))
            raw_prompt    = metadata.get('prompt') or metadata.get('Prompt')
            prompt_json   = (_coerce_to_dict(raw_prompt, "PIL prompt chunk")
                             if raw_prompt else None)

            if (workflow_json is not None
                    and 'nodes' not in workflow_json
                    and prompt_json is None
                    and any(str(k).isdigit() for k in workflow_json)):
                prompt_json, workflow_json = workflow_json, None

            return prompt_json, workflow_json
    except Exception as e:
        print(f"[PromptExtractor] Error reading PNG metadata: {e}")
        return None, None

def extract_metadata_from_jpeg(file_path):
    try:
        input_dir = folder_paths.get_input_directory()
        output_dir = folder_paths.get_output_directory()
        if file_path.startswith(input_dir):
            cache_key = os.path.relpath(file_path, input_dir).replace('\\', '/')
        elif file_path.startswith(output_dir):
            cache_key = os.path.relpath(file_path, output_dir).replace('\\', '/')
        else:
            cache_key = file_path.replace(os.sep, '/')

        if cache_key in _file_metadata_cache:
            metadata = _file_metadata_cache[cache_key]
            if isinstance(metadata, dict):
                workflow_data = _get_workflow_data(metadata)
                raw_prompt    = metadata.get('prompt') or metadata.get('Prompt')
                prompt_data   = (_coerce_to_dict(raw_prompt, "cached JPEG prompt")
                                 if raw_prompt is not None else None)

                if (workflow_data is not None
                        and 'nodes' not in workflow_data
                        and prompt_data is None
                        and any(str(k).isdigit() for k in workflow_data)):
                    prompt_data, workflow_data = workflow_data, None

                return prompt_data, workflow_data

        if not IMAGE_SUPPORT:
            return None, None

        with Image.open(file_path) as img:
            combined_meta = {}

            exif = img.getexif()
            if exif:
                for tag_id in (0x010e, 0x010f):
                    tag_val = exif.get(tag_id)
                    if not tag_val:
                        continue
                    if isinstance(tag_val, bytes):
                        tag_val = tag_val.decode('utf-8', errors='ignore')
                    tag_val = tag_val.strip().rstrip('\x00')
                    if tag_val.startswith('Workflow:'):
                        combined_meta['workflow'] = tag_val[len('Workflow:'):].strip()
                    elif tag_val.startswith('Prompt:'):
                        combined_meta['prompt'] = tag_val[len('Prompt:'):].strip()

                user_comment = exif.get(0x9286)
                if user_comment:
                    if isinstance(user_comment, bytes):
                        user_comment = user_comment.decode('utf-8', errors='ignore')
                    if user_comment.startswith('UNICODE'):
                        user_comment = user_comment[7:].lstrip('\x00')
                    parsed_uc = _coerce_to_dict(user_comment, "EXIF UserComment")
                    if isinstance(parsed_uc, dict):
                        combined_meta.update(parsed_uc)

            if hasattr(img, 'info'):
                for k, v in img.info.items():
                    if k not in combined_meta:
                        combined_meta[k] = v

            workflow_data = _get_workflow_data(combined_meta)
            raw_prompt    = combined_meta.get('prompt') or combined_meta.get('Prompt')
            prompt_data   = (_coerce_to_dict(raw_prompt, "JPEG prompt")
                             if raw_prompt is not None else None)

            if (workflow_data is not None
                    and 'nodes' not in workflow_data
                    and prompt_data is None
                    and any(str(k).isdigit() for k in workflow_data)):
                prompt_data, workflow_data = workflow_data, None

            return prompt_data, workflow_data
    except Exception as e:
        print(f"[PromptExtractor] Error reading JPEG/WebP metadata: {e}")
        return None, None

def extract_metadata_from_json(file_path):
    try:
        input_dir = folder_paths.get_input_directory()
        output_dir = folder_paths.get_output_directory()
        if file_path.startswith(input_dir):
            cache_key = os.path.relpath(file_path, input_dir).replace('\\', '/')
        elif file_path.startswith(output_dir):
            cache_key = os.path.relpath(file_path, output_dir).replace('\\', '/')
        else:
            cache_key = file_path.replace(os.sep, '/')

        if cache_key in _file_metadata_cache:
            data = _file_metadata_cache[cache_key]
        else:
            with open(file_path, 'r', encoding='utf-8') as f:
                data = json.load(f)

        if isinstance(data, dict):
            if 'prompt' in data or 'workflow' in data:
                raw_p = data.get('prompt')
                raw_w = data.get('workflow')
                return (_coerce_to_dict(raw_p, "JSON prompt key") if raw_p is not None else None,
                        _coerce_to_dict(raw_w, "JSON workflow key") if raw_w is not None else None)
            if 'nodes' in data:
                return None, data
            if any(isinstance(v, dict) and 'class_type' in v for v in data.values()):
                return data, None

        return data, None
    except Exception as e:
        print(f"[PromptExtractor] Error reading JSON file: {e}")
        return None, None

# ── Workflow Graph Traversal ──────────────────────────────────────────────────

def build_link_map(workflow_data):
    link_map = {}
    links = workflow_data.get('links', [])
    for link in links:
        if len(link) >= 5:
            link_map[link[0]] = {
                'source_node': link[1],
                'source_slot': link[2],
                'dest_node': link[3],
                'dest_slot': link[4]
            }

    if 'definitions' in workflow_data and 'subgraphs' in workflow_data['definitions']:
        for subgraph in workflow_data['definitions']['subgraphs']:
            if 'links' in subgraph:
                for link in subgraph['links']:
                    if isinstance(link, dict) and link.get('id'):
                        link_map[link['id']] = {
                            'source_node': link.get('origin_id'),
                            'source_slot': link.get('origin_slot'),
                            'dest_node': link.get('target_id'),
                            'dest_slot': link.get('target_slot')
                        }
                    elif len(link) >= 5:
                        link_map[link[0]] = {
                            'source_node': link[1],
                            'source_slot': link[2],
                            'dest_node': link[3],
                            'dest_slot': link[4]
                        }
    return link_map

def build_node_map(workflow_data):
    node_map = {}
    nodes = workflow_data.get('nodes', [])
    for node in nodes:
        node_id = node.get('id')
        if node_id is not None:
            node_map[node_id] = node

    if 'definitions' in workflow_data and 'subgraphs' in workflow_data['definitions']:
        for subgraph in workflow_data['definitions']['subgraphs']:
            if 'nodes' in subgraph:
                for node in subgraph['nodes']:
                    node_id = node.get('id')
                    if node_id is not None:
                        node_map[node_id] = node
    return node_map

def determine_clip_text_encode_type(node_id, workflow_data, node_map):
    links = workflow_data.get('links', [])
    for link in links:
        if len(link) >= 5:
            source_node_id = link[1]
            dest_node_id = link[3]
            dest_slot = link[4]

            if source_node_id == node_id:
                dest_node = node_map.get(dest_node_id)
                if dest_node:
                    dest_inputs = dest_node.get('inputs', [])
                    if dest_slot < len(dest_inputs):
                        input_name = dest_inputs[dest_slot].get('name', '').lower()
                        if 'positive' in input_name:
                            return 'positive'
                        elif 'negative' in input_name:
                            return 'negative'
    return None

def traverse_to_find_text(node_id, input_slot, node_map, link_map, visited=None, max_depth=20):
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

    if node_type in ['PrimitiveStringMultiline', 'PrimitiveString', 'String', 'Text']:
        for val in widgets_values:
            if isinstance(val, str) and val.strip():
                return val.strip()

    if node_type in ['CLIPTextEncode', 'CLIPTextEncodeSDXL', 'CLIPTextEncodeFlux']:
        for val in widgets_values:
            if isinstance(val, str) and len(val) > 10:
                return val.strip()
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

    if node_type in ['StringConcatenate', 'Text Concatenate', 'Concat String']:
        parts = []
        delimiter = " "
        for val in widgets_values:
            if isinstance(val, str) and len(val) <= 3:
                delimiter = val
                break
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

    if node_type in ['Text Find and Replace', 'FindReplace', 'String Replace']:
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

    if node_type in ['Florence2Run', 'Florence2']:
        for val in widgets_values:
            if isinstance(val, str) and len(val) > 20:
                return val.strip()
        return ""

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

    for val in widgets_values:
        if isinstance(val, str) and len(val) > 20:
            return val.strip()

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

# ── Execution Graph Traversal (API Format) ────────────────────────────────────

_PROMPT_NODE_REGISTRY = {
    "CLIPTextEncode":           ["text"],
    "CLIPTextEncodeSDXL":       ["text", "text_g", "text_l"],
    "CLIPTextEncodeFlux":       ["text", "clip_l", "t5xxl"],
    "Prompt Verify":            ["prompt_verify_master", "text", "prompt"],
    "TextMultiline":            ["text"],
    "String":                   ["text", "string"],
    "PrimitiveStringMultiline": ["text", "string"],
    "PrimitiveString":          ["text", "string"],
    "ShowText":                 ["text"],
    "Text Concatenate":         ["text_a", "text_b", "string_a", "string_b"],
    "StringConcatenate":        ["string_a", "string_b"],
    "easy showAnything":        ["text"],
}

_SAMPLER_TIER1 = {
    "KSampler", "KSamplerAdvanced",
    "WanVideoKSampler", "WanMoeKSamplerAdvanced",
}

_SAMPLER_TIER2 = {
    "SamplerCustom", "SamplerCustomAdvanced",
}

_GUIDER_CLASS_TYPES = {
    "CFGGuider", "BasicGuider", "DualCFGGuider",
    "PerpNegGuider", "CFGGuiderSimple",
    "ConditioningCombine", "ConditioningConcat", "ConditioningSetArea",
    "ConditioningSetMask", "ConditioningSetTimestepRange",
    "ReferenceLatent",
}

def _is_connection_ref(value):
    return (
        isinstance(value, (list, tuple))
        and len(value) == 2
        and isinstance(value[1], int)
    )

def _find_sampler_nodes_api(data):
    tier1 = []
    tier2 = []
    tier3 = []

    for nid, nd in data.items():
        if not isinstance(nd, dict):
            continue
        ct     = nd.get("class_type", "")
        inputs = nd.get("inputs", {})

        if ct in _GUIDER_CLASS_TYPES:
            continue

        has_pos_neg = ("positive" in inputs or "negative" in inputs)

        if ct in _SAMPLER_TIER1:
            tier1.append((nid, nd))
        elif ct in _SAMPLER_TIER2:
            tier2.append((nid, nd))
        elif has_pos_neg:
            tier3.append((nid, nd))

    if tier1:
        return tier1
    if tier2:
        return tier2
    return tier3

def _resolve_prompt_api(node_id_str, data, visited=None):
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
        return ""

    for key, val in inputs.items():
        if isinstance(val, str) and val.strip():
            if _looks_like_prompt(val):
                return val.strip()
        elif _is_connection_ref(val):
            lkey = key.lower()
            if any(kw in lkey for kw in ("text", "prompt", "string", "caption")):
                result = _resolve_prompt_api(str(val[0]), data, visited)
                if result:
                    return result

    for key, val in inputs.items():
        if _is_connection_ref(val):
            result = _resolve_prompt_api(str(val[0]), data, visited)
            if result:
                return result

    return ""

def _looks_like_prompt(text):
    if not text or len(text) < 30:
        return False
    if ' ' not in text:
        return False
    stripped = text.strip()
    if stripped.startswith(("{", "[", "http", "/")):
        return False
    if any(stripped.lower().endswith(ext) for ext in
           (".png", ".jpg", ".jpeg", ".webp", ".safetensors", ".ckpt", ".pt")):
        return False
    alpha_ratio = sum(1 for c in stripped if c.isalpha()) / max(len(stripped), 1)
    if alpha_ratio < 0.4:
        return False
    return True

def _fallback_scan_api(data):
    candidates = []
    for nid, nd in data.items():
        if not isinstance(nd, dict):
            continue
        inputs = nd.get("inputs", {})
        for key, val in inputs.items():
            if not isinstance(val, str):
                continue
            if not _looks_like_prompt(val):
                continue
            score = len(val) + val.count(",") * 5
            candidates.append((score, val.strip()))
    if not candidates:
        return ""
    candidates.sort(reverse=True)
    return candidates[0][1]

def _extract_prompts_via_graph_traversal(data):
    if not isinstance(data, dict):
        return "", ""

    positive_str = ""
    negative_str = ""

    samplers = _find_sampler_nodes_api(data)

    for sampler_id, sampler_node in reversed(samplers):
        inputs  = sampler_node.get("inputs", {})
        ct      = sampler_node.get("class_type", "")

        pos_ref = inputs.get("positive")
        neg_ref = inputs.get("negative")

        if not _is_connection_ref(pos_ref) and not _is_connection_ref(neg_ref):
            guider_ref = inputs.get("guider")
            if _is_connection_ref(guider_ref):
                guider_node = data.get(str(guider_ref[0]), {})
                guider_inputs = guider_node.get("inputs", {})
                pos_ref = guider_inputs.get("positive") or pos_ref
                neg_ref = guider_inputs.get("negative") or neg_ref

        if not positive_str and _is_connection_ref(pos_ref):
            positive_str = _resolve_prompt_api(str(pos_ref[0]), data, set())

        if not negative_str and _is_connection_ref(neg_ref):
            negative_str = _resolve_prompt_api(str(neg_ref[0]), data, set())

        if positive_str and negative_str:
            break

    if not positive_str and not negative_str:
        positive_str = _fallback_scan_api(data)

    return positive_str, negative_str


# ── Main Extractor Logic ──────────────────────────────────────────────────────

def parse_workflow_for_prompts(prompt_data, workflow_data=None):
    result = {
        'positive_prompt': '',
        'negative_prompt': ''
    }

    if not prompt_data and not workflow_data:
        return result

    prompt_data, workflow_data = _normalise_metadata_pair(prompt_data, workflow_data)

    if not prompt_data and not workflow_data:
        return result

    if isinstance(prompt_data, dict) and 'prompt' in prompt_data and ('loras' in prompt_data or 'negative_prompt' in prompt_data):
        result['positive_prompt'] = prompt_data.get('prompt', '')
        result['negative_prompt'] = prompt_data.get('negative_prompt', '')
        return result

    node_map = {}
    link_map = {}
    if workflow_data and isinstance(workflow_data, dict) and 'nodes' in workflow_data:
        node_map = build_node_map(workflow_data)
        link_map = build_link_map(workflow_data)

    data = prompt_data if prompt_data else {}

    if not prompt_data and workflow_data:
        data = convert_workflow_to_prompt_format(workflow_data)

    if not isinstance(data, dict):
        return result

    positive_prompts = []
    negative_prompts = []

    all_workflow_nodes = []
    if workflow_data:
        if 'nodes' in workflow_data:
            all_workflow_nodes.extend(workflow_data.get('nodes', []))

        if 'definitions' in workflow_data and 'subgraphs' in workflow_data['definitions']:
            for subgraph in workflow_data['definitions']['subgraphs']:
                if 'nodes' in subgraph:
                    all_workflow_nodes.extend(subgraph['nodes'])

    if all_workflow_nodes:
        for node in all_workflow_nodes:
            if not isinstance(node, dict):
                continue

            node_type = node.get('type', '')
            node_id = node.get('id')
            title = node.get('title', '')
            widgets_values = node.get('widgets_values', [])
            inputs = node.get('inputs', [])

            if node_type in ['CLIPTextEncode', 'CLIPTextEncodeSDXL', 'CLIPTextEncodeFlux']:
                connection_type = determine_clip_text_encode_type(node_id, workflow_data, node_map)

                if not connection_type:
                    title_lower = title.lower() if title else ""
                    if 'negative' in title_lower:
                        connection_type = 'negative'
                    elif 'positive' in title_lower:
                        connection_type = 'positive'
                    else:
                        connection_type = 'positive'

                text_found = ""
                for val in widgets_values:
                    if isinstance(val, str) and len(val) > 10:
                        text_found = val.strip()
                        break

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

            elif node_type == 'PrimitiveStringMultiline':
                title_lower = title.lower() if title else ""
                is_negative = 'negative' in title_lower

                for val in widgets_values:
                    if isinstance(val, str) and len(val) > 20:
                        if is_negative:
                            negative_prompts.append(val.strip())
                        else:
                            positive_prompts.append(val.strip())
                        break

    for node_id, node_data in data.items():
        if not isinstance(node_data, dict):
            continue

        class_type = node_data.get('class_type', '')
        inputs = node_data.get('inputs', {})

        if class_type in ['CLIPTextEncode', 'CLIPTextEncodeSDXL', 'CLIPTextEncodeFlux']:
            text = inputs.get('text', '')
            if text and isinstance(text, str):
                connection_type = None
                if node_map:
                    actual_node_id = int(node_id) if str(node_id).isdigit() else node_id
                    connection_type = determine_clip_text_encode_type(actual_node_id, workflow_data, node_map)

                if not connection_type and node_map:
                    node = node_map.get(actual_node_id)
                    if node:
                        title_lower = node.get('title', '').lower()
                        if 'negative' in title_lower:
                            connection_type = 'negative'
                        elif 'positive' in title_lower:
                            connection_type = 'positive'

                if connection_type == 'negative':
                    negative_prompts.append(text)
                else:
                    positive_prompts.append(text)

    if data:
        try:
            gt_pos, gt_neg = _extract_prompts_via_graph_traversal(data)
            if gt_pos or gt_neg:
                if gt_pos:
                    positive_prompts = [gt_pos]
                if gt_neg:
                    negative_prompts = [gt_neg]
        except Exception as _gt_err:
            print(f"{TAG} [graph-traversal] Error (non-fatal): {_gt_err}")

    clean_positive = []
    for p in positive_prompts:
        cleaned = re.sub(r'\s+', ' ', p).strip()
        if cleaned:
            clean_positive.append(cleaned)

    clean_negative = []
    for p in negative_prompts:
        cleaned = re.sub(r'\s+', ' ', p).strip()
        if cleaned:
            clean_negative.append(cleaned)

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

    result['positive_prompt'] = ', '.join(clean_positive) if clean_positive else ''
    result['negative_prompt'] = ', '.join(clean_negative) if clean_negative else ''

    return result

def convert_workflow_to_prompt_format(workflow_data):
    if not isinstance(workflow_data, dict):
        return {}

    result = {}

    all_nodes = []
    if 'nodes' in workflow_data:
        all_nodes.extend(workflow_data.get('nodes', []))

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
        inputs = {}

        if class_type in ['CLIPTextEncode', 'CLIPTextEncodeSDXL']:
            if widgets_values:
                inputs['text'] = widgets_values[0] if widgets_values else ''

        result[node_id] = {
            'class_type': class_type,
            'inputs': inputs
        }

    return result

def load_image_as_tensor(file_path):
    if not IMAGE_SUPPORT:
        return None

    try:
        img = Image.open(file_path)
        if img.mode != 'RGB':
            img = img.convert('RGB')

        img_array = np.array(img).astype(np.float32) / 255.0
        img_tensor = torch.from_numpy(img_array).unsqueeze(0)
        return img_tensor
    except Exception as e:
        print(f"[PromptExtractor] Error loading image: {e}")
        return None

def _placeholder_tensor():
    if IMAGE_SUPPORT:
        arr = np.full((128, 128, 3), 42.0 / 255.0, dtype=np.float32)
        return torch.from_numpy(arr).unsqueeze(0)
    return torch.zeros((1, 128, 128, 3), dtype=torch.float32)

def _placeholder_mask():
    """Return an empty (all-black) 1x128x128 mask tensor."""
    return torch.zeros((1, 128, 128), dtype=torch.float32)

def _load_mask_for_image(image_path):
    """
    Load a saved mask for the given image path.
    Looks next to the image first, then in the ComfyUI input directory.
    Returns a (1, H, W) float32 tensor, or a placeholder if no mask exists.
    """
    if not IMAGE_SUPPORT or not image_path:
        return _placeholder_mask()
    try:
        filename = os.path.basename(image_path)
        name, _ = os.path.splitext(filename)
        mask_filename = f"{name}_mask.png"

        # Priority 1: same directory as the image
        candidate = os.path.join(os.path.dirname(image_path), mask_filename)
        # Priority 2: ComfyUI input directory
        input_candidate = os.path.join(folder_paths.get_input_directory(), mask_filename)

        mask_file = None
        if os.path.exists(candidate):
            mask_file = candidate
        elif os.path.exists(input_candidate):
            mask_file = input_candidate

        if mask_file is None:
            return _placeholder_mask()

        with Image.open(mask_file) as mask_img:
            if "A" in mask_img.getbands():
                mask_data = mask_img.split()[-1]
            else:
                mask_data = mask_img.convert("L")
            mask_np = np.array(mask_data).astype(np.float32) / 255.0
            return torch.from_numpy(mask_np).unsqueeze(0)
    except Exception as e:
        print(f"{TAG} Warning: could not load mask for {image_path}: {e}")
        return _placeholder_mask()

# ── API Endpoints ─────────────────────────────────────────────────────────────

@server.PromptServer.instance.routes.post("/meta-prompt-extractor/cache-file-metadata")
async def _cache_file_metadata(request):
    try:
        data = await request.json()
        filename = data.get("filename")
        metadata = data.get("metadata")
        if not filename:
            return server.web.json_response({"success": False, "error": "Missing filename"}, status=400)
        if metadata:
            norm_key = filename.replace("\\", "/").replace("\\", "/")
            _file_metadata_cache[norm_key] = metadata
            print(f"{TAG} Cached metadata key: {norm_key}")
        return server.web.json_response({"success": True})
    except Exception as e:
        return server.web.json_response({"success": False, "error": str(e)}, status=500)

@server.PromptServer.instance.routes.get("/meta-prompt-extractor/list-roots")
async def _list_filesystem_roots(request):
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

def _fast_png_has_metadata(file_path):
    """
    Check PNG tEXt/iTXt/zTXt chunks for 'prompt' or 'workflow' keys WITHOUT
    decoding pixel data.  Reads only the chunk headers (12 bytes each) and the
    keyword portion of text chunks — typically finishes in < 1 ms even on HDD.
    Returns True as soon as a matching keyword is found.
    """
    TARGET = {b'prompt', b'workflow', b'Comment', b'parameters'}
    try:
        with open(file_path, 'rb') as fh:
            sig = fh.read(8)
            if sig != b'\x89PNG\r\n\x1a\n':
                return False
            while True:
                hdr = fh.read(8)
                if len(hdr) < 8:
                    break
                length = int.from_bytes(hdr[:4], 'big')
                chunk_type = hdr[4:]
                if chunk_type in (b'tEXt', b'iTXt', b'zTXt'):
                    # Read just enough to get the null-terminated keyword (max 79 bytes)
                    peek = min(length, 80)
                    data = fh.read(peek)
                    keyword = data.split(b'\x00', 1)[0]
                    if keyword.lower() in {t.lower() for t in TARGET}:
                        return True
                    # Skip rest of chunk + CRC
                    fh.seek(length - peek + 4, 1)
                elif chunk_type == b'IDAT':
                    # Pixel data started — no more metadata chunks after this
                    break
                else:
                    fh.seek(length + 4, 1)  # skip data + CRC
    except Exception:
        pass
    return False


# In-memory metadata-presence cache: maps normalised path → bool
# Populated during directory listing; cleared when the browse path changes.
_has_metadata_cache = {}


def _check_file_has_metadata(file_path):
    """
    Fast metadata-presence check used during directory listing.
    Uses _fast_png_has_metadata() for PNGs (no PIL, no pixel decode).
    Falls back to a quick binary grep for JPEG/WEBP EXIF markers.
    Reads JSON files fully (they are usually small).
    Results are cached in _has_metadata_cache so repeated calls are O(1).
    """
    try:
        cache_key = file_path.replace(os.sep, '/')
        if cache_key in _has_metadata_cache:
            return _has_metadata_cache[cache_key]
        if cache_key in _file_metadata_cache:
            _has_metadata_cache[cache_key] = True
            return True

        ext = os.path.splitext(file_path)[1].lower()
        if ext not in ('.png', '.jpg', '.jpeg', '.webp', '.json'):
            _has_metadata_cache[cache_key] = False
            return False

        result = False

        if ext == '.png':
            result = _fast_png_has_metadata(file_path)

        elif ext in ('.jpg', '.jpeg'):
            # JFIF/EXIF: just check for APP1 marker (FF E1) in first 512 bytes
            try:
                with open(file_path, 'rb') as fh:
                    header = fh.read(512)
                result = b'\xff\xe1' in header  # APP1 = Exif or XMP
            except Exception:
                result = False

        elif ext == '.webp':
            # WEBP EXIF chunk starts with b'EXIF'; XMP with b'XMP '
            try:
                with open(file_path, 'rb') as fh:
                    header = fh.read(256)
                result = b'EXIF' in header or b'XMP ' in header
            except Exception:
                result = False

        elif ext == '.json':
            try:
                with open(file_path, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                result = isinstance(data, dict) and bool(
                    data.get('nodes') or data.get('prompt') or data.get('workflow')
                )
            except Exception:
                result = False

        _has_metadata_cache[cache_key] = result
        return result
    except Exception:
        return False

@server.PromptServer.instance.routes.get("/meta-prompt-extractor/browse")
async def _browse_filesystem(request):
    SUPPORTED = {".png", ".jpg", ".jpeg", ".webp", ".json"}
    IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp"}
    try:
        path = request.rel_url.query.get("path", "") or os.path.expanduser("~")
        browse_type = request.rel_url.query.get("type", "files")  # "files" or "folders"
        path = os.path.normpath(path)
        if not os.path.isdir(path):
            return server.web.json_response({"error": "Not a directory"}, status=400)

        # Clear per-directory metadata cache so it never grows unbounded
        if browse_type != "folders":
            _has_metadata_cache.clear()

        entries = []
        try:
            for name in sorted(os.listdir(path), key=lambda n: (not os.path.isdir(os.path.join(path, n)), n.lower())):
                full  = os.path.join(path, name)
                is_dir = os.path.isdir(full)
                
                if browse_type == "folders" and not is_dir:
                    continue  # Skip files when browsing folders only
                
                ext   = os.path.splitext(name)[1].lower()
                
                if is_dir:
                    entries.append({"name": name, "path": full, "type": "dir"})
                elif ext in SUPPORTED:
                    try:
                        stat = os.stat(full)
                        size = stat.st_size
                        mtime = stat.st_mtime
                    except:
                        size = 0
                        mtime = 0
                    
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
    try:
        data = await request.json()
        path = data.get("path", "")
        
        if not path:
            return server.web.json_response({"success": False, "error": "No path provided"}, status=400)
        
        path = os.path.normpath(path)
        
        if not os.path.exists(path):
            return server.web.json_response({"success": False, "error": "Path does not exist"}, status=404)
        
        if os.path.isfile(path):
            path = os.path.dirname(path)
        
        import platform
        import subprocess
        
        try:
            abs_path = os.path.abspath(path)
            if platform.system() == "Windows":
                subprocess.Popen(f'explorer "{abs_path}"', shell=True)
            elif platform.system() == "Darwin":
                subprocess.Popen(["open", "-R", abs_path])
            else:
                subprocess.Popen(["xdg-open", abs_path])
            
            return server.web.json_response({"success": True, "message": f"Opened: {abs_path}"})
        except Exception as e:
            return server.web.json_response({"success": False, "error": f"Failed to open explorer: {str(e)}"}, status=500)
    except Exception as e:
        return server.web.json_response({"success": False, "error": str(e)}, status=500)

@server.PromptServer.instance.routes.get("/meta-prompt-extractor/open-file-dialog")
async def _open_file_dialog(request):
    import asyncio
    import concurrent.futures

    FILETYPES = [
        ("Supported files", "*.png *.jpg *.jpeg *.webp *.json"),
        ("Images",      "*.png *.jpg *.jpeg *.webp"),
        ("JSON workflows", "*.json"),
        ("All files",   "*.*"),
    ]

    initial_dir = request.rel_url.query.get("initial_dir", "") or os.path.expanduser("~")
    if not os.path.isdir(initial_dir):
        initial_dir = os.path.expanduser("~")

    def _show_dialog():
        try:
            import tkinter as tk
            from tkinter import filedialog
            root = tk.Tk()
            root.withdraw()
            root.wm_attributes("-topmost", True)
            path = filedialog.askopenfilename(
                parent=root,
                title="Select Image, Video, or Workflow JSON",
                initialdir=initial_dir,
                filetypes=FILETYPES,
            )
            root.destroy()
            return path or ""
        except Exception as e:
            return ""

    try:
        loop = asyncio.get_event_loop()
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            path = await loop.run_in_executor(pool, _show_dialog)

        if path:
            path = path.replace("\\", "/")
            return server.web.json_response({"path": path, "cancelled": False})
        else:
            return server.web.json_response({"path": "", "cancelled": True})

    except Exception as e:
        return server.web.json_response(
            {"path": "", "cancelled": True, "error": str(e)},
            status=500
        )

@server.PromptServer.instance.routes.get("/meta-prompt-extractor/extract-preview-abs")
async def _extract_preview_abs(request):
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
        return server.web.json_response({"extracted": None, "error": str(e)}, status=500)


# ── ComfyUI Node Class ────────────────────────────────────────────────────────

# ─────────────────────────────────────────────────────────────────────────────
# Conditioning → text extraction via graph traversal
#
# ComfyUI conditioning is [[cond_tensor, {"pooled_output": pooled_tensor}], ...]
# The text that was encoded is NOT stored in the conditioning dict — it is
# baked into the tensor and is not recoverable from the tensor alone.
#
# The correct approach is to use the API-format prompt graph that ComfyUI
# injects via the hidden "PROMPT" input, along with the node's own unique_id,
# to find which upstream node feeds the conditioning slot and then walk
# backwards through the graph using the existing _resolve_prompt_api logic
# to read the text widget value of the upstream CLIPTextEncode (or equivalent).
# ─────────────────────────────────────────────────────────────────────────────

def _find_source_node_for_conditioning(unique_id, prompt_graph, input_slot_name="conditioning"):
    """
    Given the unique_id of the MetaPromptExtractor node and the full
    API-format prompt graph (dict of node_id -> node_data), find the node_id
    of whichever node is connected to the named conditioning input slot.

    ComfyUI API format stores inputs as either:
      - a plain value  (string / int / float)
      - a connection   [source_node_id, source_output_slot_index]

    Returns the source node_id string, or None if no connection is found.
    """
    if not prompt_graph or not unique_id:
        return None

    own_node = prompt_graph.get(str(unique_id))
    if not own_node or not isinstance(own_node, dict):
        return None

    inputs = own_node.get("inputs", {})
    cond_ref = inputs.get(input_slot_name)

    # A connection reference is [node_id, output_slot] where node_id is an int
    # and output_slot is an int (0-based index of which output of that node).
    if (isinstance(cond_ref, (list, tuple))
            and len(cond_ref) == 2
            and isinstance(cond_ref[0], (int, str))
            and isinstance(cond_ref[1], int)):
        return str(cond_ref[0])

    return None


def extract_prompts_from_conditioning_via_graph(conditioning, unique_id, prompt_graph,
                                                input_slot_name="conditioning"):
    """
    Extract the text prompt that was encoded into `conditioning` by walking
    backwards through the ComfyUI API-format prompt graph.

    Args:
        conditioning      : the CONDITIONING value (used only to confirm
                            something is connected; text is NOT in the tensor).
        unique_id         : this node's unique_id string (hidden UNIQUE_ID).
        prompt_graph      : full API-format prompt dict (hidden PROMPT input).
        input_slot_name   : which input slot to trace — "conditioning" for the
                            positive slot, "conditioning_negative" for the
                            negative slot.

    Returns:
        (positive_text, negative_text) — either or both may be empty strings.
    """
    positive_text = ""
    negative_text = ""

    if conditioning is None or not prompt_graph:
        return positive_text, negative_text

    # Step 1 — find which upstream node feeds this conditioning slot
    source_node_id = _find_source_node_for_conditioning(
        unique_id, prompt_graph, input_slot_name
    )
    if not source_node_id:
        print(f"{TAG} [conditioning] Could not find upstream node for slot '{input_slot_name}'.")
        return positive_text, negative_text

    source_node = prompt_graph.get(source_node_id, {})
    source_class = source_node.get("class_type", "")
    print(f"{TAG} [conditioning] Slot '{input_slot_name}' → node id={source_node_id} class_type={source_class!r}")

    # Step 2 — determine polarity.
    # For the explicit negative slot, always treat as negative regardless of
    # the upstream node's class.  For the positive slot, apply a class check.
    KNOWN_NEGATIVE_CLASSES = {
        "CLIPTextEncodeNegative",
        "ConditioningNegative",
    }
    if input_slot_name == "conditioning_negative":
        is_negative = True
    else:
        is_negative = source_class in KNOWN_NEGATIVE_CLASSES

    # Step 3 — walk backwards through the graph to find the text
    extracted = _resolve_prompt_api(source_node_id, prompt_graph, set())

    if extracted:
        if is_negative:
            negative_text = extracted
        else:
            positive_text = extracted
        print(f"{TAG} [conditioning] Extracted {'negative' if is_negative else 'positive'} prompt "
              f"from slot '{input_slot_name}': {extracted[:80]!r}{'...' if len(extracted) > 80 else ''}")
    else:
        print(f"{TAG} [conditioning] No text found walking upstream from node {source_node_id}.")

    return positive_text, negative_text


def _extract_text_from_cond_dict(conditioning):
    """
    Last-resort fallback: some custom nodes DO store the prompt string directly
    in the conditioning dict under non-standard keys.  Check a broad list of
    candidates.  Returns the first non-empty string found, or "".
    """
    if not conditioning or not isinstance(conditioning, (list, tuple)):
        return ""
    for entry in conditioning:
        if not isinstance(entry, (list, tuple)) or len(entry) < 2:
            continue
        cond_dict = entry[1]
        if not isinstance(cond_dict, dict):
            continue
        for key in ("text", "prompt", "cond_text", "positive", "encoded_text",
                    "caption", "description"):
            val = cond_dict.get(key)
            if isinstance(val, str) and val.strip():
                return val.strip()
        # Some flux-style encoders nest the text inside pooled_output
        pooled = cond_dict.get("pooled_output")
        if isinstance(pooled, dict):
            for key in ("text", "prompt"):
                val = pooled.get(key)
                if isinstance(val, str) and val.strip():
                    return val.strip()
    return ""


class MetaPromptExtractor:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": (["(none)", ""], {
                    "tooltip": "Absolute path to a file. Use the Browse button.",
                }),
            },
            "optional": {
                "conditioning": ("CONDITIONING", {
                    "tooltip": (
                        "Optional positive conditioning input. Connect a CLIPTextEncode "
                        "(or equivalent) node here. When 'use conditioning' is ON the "
                        "extracted text is forwarded to the positive_prompt output, "
                        "overriding any file-based extraction."
                    ),
                }),
                "conditioning_negative": ("CONDITIONING", {
                    "tooltip": (
                        "Optional negative conditioning input. Connect a CLIPTextEncode "
                        "(or equivalent) node here. When 'use conditioning' is ON the "
                        "extracted text is forwarded to the negative_prompt output, "
                        "overriding any file-based extraction."
                    ),
                }),
                "use_conditioning": ("BOOLEAN", {
                    "default": False,
                    "label_on":  "",
                    "label_off": "",
                    "tooltip": (
                        "When ON: conditioning inputs take priority over file-based "
                        "extraction. Turns ON automatically when a conditioning input "
                        "is connected. Turn OFF to fall back to Browse Files extraction "
                        "even if conditioning inputs are connected."
                    ),
                }),
            },
            "hidden": {
                "unique_id":     "UNIQUE_ID",
                "extra_pnginfo": "EXTRA_PNGINFO",
                "prompt":        "PROMPT",
            },
        }

    CATEGORY    = "utils"
    DESCRIPTION = (
        "Extract positive and negative prompts from ComfyUI images "
        "or workflow JSON files stored anywhere on disk."
    )
    RETURN_TYPES  = ("STRING", "STRING", "IMAGE", "MASK", "STRING")
    RETURN_NAMES  = ("positive_prompt", "negative_prompt", "image", "mask", "path")
    FUNCTION      = "extract"
    OUTPUT_NODE   = False

    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs):
        return True

    def extract(self, image="", conditioning=None, conditioning_negative=None,
                use_conditioning=False, unique_id=None,
                extra_pnginfo=None, prompt=None, **kwargs):
        positive_prompt = ""
        negative_prompt = ""
        image_tensor    = None

        # ── Determine whether conditioning extraction is active ────────────────
        # Conditioning takes priority when:
        #   • use_conditioning is True (either set manually or auto-set by the
        #     JS when a connection is made), AND
        #   • at least one conditioning input is actually connected.
        any_cond_connected = (conditioning is not None
                              or conditioning_negative is not None)
        use_cond_active = bool(use_conditioning) and any_cond_connected

        # ── Step 1: File-based extraction ──────────────────────────────────────
        # Always run so we always have a valid image tensor to display/output.
        # The text results are only used when conditioning is NOT active.
        file_path = (image or "").strip()
        fallback_path = folder_paths.get_input_directory()

        resolved = None
        if file_path and file_path not in ("", "(none)"):
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

        file_positive = ""
        file_negative = ""
        if resolved and not use_cond_active:
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
                parsed        = parse_workflow_for_prompts(prompt_data, workflow_raw)
                file_positive = parsed.get("positive_prompt") or ""
                file_negative = parsed.get("negative_prompt") or ""
        else:
            resolved = None

        # ── Step 2: Conditioning-based extraction ──────────────────────────────
        # The CONDITIONING tensor does NOT store the original text — the text is
        # encoded into a float tensor and cannot be decoded back.
        #
        # We use the API-format prompt graph (injected via the hidden "PROMPT"
        # input) to locate our own node, identify which upstream nodes are wired
        # to our conditioning slots, then walk backwards with _resolve_prompt_api
        # to read the text widget values of those upstream encoder nodes.
        cond_positive = ""
        cond_negative = ""

        if any_cond_connected:
            # Build the prompt graph
            prompt_graph = None
            if isinstance(prompt, dict) and prompt:
                prompt_graph = prompt
            elif (isinstance(extra_pnginfo, dict)
                  and "workflow" in extra_pnginfo
                  and isinstance(extra_pnginfo["workflow"], dict)):
                wf = extra_pnginfo["workflow"]
                prompt_graph = convert_workflow_to_prompt_format(wf) or None

            if prompt_graph:
                # Positive conditioning slot
                if conditioning is not None:
                    cond_pos_raw, _ = extract_prompts_from_conditioning_via_graph(
                        conditioning, unique_id, prompt_graph,
                        input_slot_name="conditioning"
                    )
                    cond_positive = cond_pos_raw

                # Negative conditioning slot — separate graph lookup using its
                # own slot name so _find_source_node_for_conditioning reads the
                # correct input key from our node's entry in the graph.
                if conditioning_negative is not None:
                    _, cond_neg_raw = extract_prompts_from_conditioning_via_graph(
                        conditioning_negative, unique_id, prompt_graph,
                        input_slot_name="conditioning_negative"
                    )
                    # The helper returns (pos, neg) based on polarity detection;
                    # since this is explicitly the negative slot, treat anything
                    # found as negative regardless of polarity heuristic.
                    if not cond_neg_raw:
                        # Polarity heuristic may have put it in "positive" side —
                        # re-run and take whatever came back
                        cond_neg_raw_pos, cond_neg_raw_neg =                             extract_prompts_from_conditioning_via_graph(
                                conditioning_negative, unique_id, prompt_graph,
                                input_slot_name="conditioning_negative"
                            )
                        cond_neg_raw = cond_neg_raw_neg or cond_neg_raw_pos
                    cond_negative = cond_neg_raw

            else:
                # Last resort: some custom nodes store text in the cond dict
                if conditioning is not None:
                    cond_positive = _extract_text_from_cond_dict(conditioning)
                if conditioning_negative is not None:
                    cond_negative = _extract_text_from_cond_dict(conditioning_negative)
                if cond_positive or cond_negative:
                    print(f"{TAG} [conditioning] Recovered text from cond dict (no graph).")

        # ── Step 3: Merge results according to priority ────────────────────────
        if use_cond_active:
            # Conditioning takes full priority — overrides file entirely
            positive_prompt = cond_positive
            negative_prompt = cond_negative
            print(f"{TAG} [conditioning] Using conditioning extraction (toggle ON).")
        else:
            # File-based only (conditioning idle or toggled off)
            positive_prompt = file_positive
            negative_prompt = file_negative

        # ── Step 4: Return results ─────────────────────────────────────────────
        if not resolved:
            if image_tensor is None:
                image_tensor = _placeholder_tensor()
            mask_tensor = _placeholder_mask()
            return positive_prompt, negative_prompt, image_tensor, mask_tensor, fallback_path

        if image_tensor is None:
            image_tensor = _placeholder_tensor()

        # Intelligent RGB Conversion: strip alpha channel if fully opaque
        if image_tensor is not None and image_tensor.shape[-1] == 4:
            alpha = image_tensor[:, :, :, 3]
            if float(alpha.min()) > 0.9999:
                image_tensor = image_tensor[:, :, :, :3]

        # Load mask file if it exists alongside the image
        mask_tensor = _load_mask_for_image(resolved)

        return positive_prompt, negative_prompt, image_tensor, mask_tensor, resolved

    @classmethod
    def IS_CHANGED(cls, image="", conditioning=None, conditioning_negative=None, use_conditioning=False, prompt=None, **kwargs):
        # Build a hash of: image mtime + mask mtime (if any).
        # This ensures ComfyUI re-executes whenever the mask is saved/cleared,
        # not only when the image itself changes.
        import hashlib
        h = hashlib.sha256()
        if image and image.strip() not in ("", "(none)"):
            p = image.strip()
            if not os.path.isabs(p):
                p = os.path.join(folder_paths.get_input_directory(), p)
            if os.path.isfile(p):
                h.update(str(os.path.getmtime(p)).encode())
                # Also hash the mask file if it exists
                filename = os.path.basename(p)
                name, _ = os.path.splitext(filename)
                mask_filename = f"{name}_mask.png"
                for mask_candidate in (
                    os.path.join(os.path.dirname(p), mask_filename),
                    os.path.join(folder_paths.get_input_directory(), mask_filename),
                ):
                    if os.path.isfile(mask_candidate):
                        h.update(str(os.path.getmtime(mask_candidate)).encode())
                        h.update(mask_candidate.encode())
                        break
            else:
                h.update(b"no_file")
        else:
            h.update(b"no_file")
        return h.hexdigest()

# ── File Management Endpoints ─────────────────────────────────────────────────
# These power the Move, Delete (to trash), Rename, and Mask Editor features
# inside the Browse Files floating window.

try:
    from send2trash import send2trash as _send2trash
    _TRASH_AVAILABLE = True
except ImportError:
    _TRASH_AVAILABLE = False
    print(f"{TAG} Warning: send2trash not installed; Delete will permanently remove files.")

import shutil as _shutil
import base64 as _base64

@server.PromptServer.instance.routes.post("/meta-prompt-extractor/delete-files")
async def _mpe_delete_files(request):
    try:
        data = await request.json()
        filepaths = data.get("filepaths", [])
        if not isinstance(filepaths, list):
            return server.web.json_response({"status": "error", "message": "Invalid data."}, status=400)

        errors = []
        for filepath in filepaths:
            if not filepath or not os.path.isabs(filepath) or ".." in filepath:
                continue
            if not os.path.isfile(filepath):
                continue
            try:
                if _TRASH_AVAILABLE:
                    _send2trash(os.path.normpath(filepath))
                else:
                    os.remove(filepath)
            except Exception as e:
                errors.append(f"{os.path.basename(filepath)}: {e}")

        if errors:
            return server.web.json_response({"status": "partial", "errors": errors})
        return server.web.json_response({"status": "ok"})
    except Exception as e:
        return server.web.json_response({"status": "error", "message": str(e)}, status=500)


def _resolve_unique_dest(dest_dir, filename):
    """Return a destination path that does not already exist, adding (N) suffix if needed."""
    final_dest = os.path.join(dest_dir, filename)
    if not os.path.exists(final_dest):
        return final_dest
    base, ext = os.path.splitext(filename)
    counter = 1
    while os.path.exists(final_dest):
        final_dest = os.path.join(dest_dir, f"{base} ({counter}){ext}")
        counter += 1
    return final_dest


@server.PromptServer.instance.routes.post("/meta-prompt-extractor/move-files")
async def _mpe_move_files(request):
    """Move files from their current location to a new directory (removes originals)."""
    try:
        data = await request.json()
        source_paths = data.get("source_paths", [])
        destination_dir = data.get("destination_dir", "")

        if not isinstance(source_paths, list) or not destination_dir:
            return server.web.json_response({"status": "error", "message": "Invalid data."}, status=400)

        dest = os.path.normpath(destination_dir)
        if not os.path.isabs(dest) or not os.path.isdir(dest):
            return server.web.json_response({"status": "error", "message": "Invalid destination directory."}, status=400)

        errors = []
        for src in source_paths:
            try:
                norm_src = os.path.normpath(src)
                if not os.path.isabs(norm_src) or not os.path.isfile(norm_src):
                    continue
                if os.path.dirname(norm_src) == dest:
                    continue
                final_dest = _resolve_unique_dest(dest, os.path.basename(norm_src))
                _shutil.move(norm_src, final_dest)   # moves (removes source)
            except Exception as e:
                errors.append(f"{os.path.basename(src)}: {e}")

        if errors:
            return server.web.json_response({"status": "partial", "errors": errors})
        return server.web.json_response({"status": "ok"})
    except Exception as e:
        return server.web.json_response({"status": "error", "message": str(e)}, status=500)


@server.PromptServer.instance.routes.post("/meta-prompt-extractor/copy-files")
async def _mpe_copy_files(request):
    """Copy files to a new directory, leaving originals in place."""
    try:
        data = await request.json()
        source_paths = data.get("source_paths", [])
        destination_dir = data.get("destination_dir", "")

        if not isinstance(source_paths, list) or not destination_dir:
            return server.web.json_response({"status": "error", "message": "Invalid data."}, status=400)

        dest = os.path.normpath(destination_dir)
        if not os.path.isabs(dest) or not os.path.isdir(dest):
            return server.web.json_response({"status": "error", "message": "Invalid destination directory."}, status=400)

        errors = []
        for src in source_paths:
            try:
                norm_src = os.path.normpath(src)
                if not os.path.isabs(norm_src) or not os.path.isfile(norm_src):
                    continue
                final_dest = _resolve_unique_dest(dest, os.path.basename(norm_src))
                _shutil.copy2(norm_src, final_dest)  # copies (leaves source intact)
            except Exception as e:
                errors.append(f"{os.path.basename(src)}: {e}")

        if errors:
            return server.web.json_response({"status": "partial", "errors": errors})
        return server.web.json_response({"status": "ok"})
    except Exception as e:
        return server.web.json_response({"status": "error", "message": str(e)}, status=500)


@server.PromptServer.instance.routes.post("/meta-prompt-extractor/rename-file")
async def _mpe_rename_file(request):
    try:
        data = await request.json()
        old_path = data.get("old_path", "")
        new_name = data.get("new_name", "")

        if not old_path or not os.path.isabs(old_path) or not os.path.isfile(old_path):
            return server.web.json_response({"status": "error", "message": "Invalid source file."}, status=400)
        if not new_name or "/" in new_name or "\\" in new_name:
            return server.web.json_response({"status": "error", "message": "Invalid new filename."}, status=400)

        directory = os.path.dirname(old_path)
        new_path = os.path.join(directory, new_name)

        if old_path == new_path:
            return server.web.json_response({"status": "ok", "new_path": new_path})
        if os.path.exists(new_path):
            return server.web.json_response({"status": "error", "message": "A file with that name already exists."}, status=409)

        os.rename(old_path, new_path)
        return server.web.json_response({"status": "ok", "new_path": new_path})
    except Exception as e:
        return server.web.json_response({"status": "error", "message": str(e)}, status=500)


@server.PromptServer.instance.routes.post("/meta-prompt-extractor/save-mask")
async def _mpe_save_mask(request):
    """Save mask PNG alongside the source image (or in ComfyUI input dir)."""
    try:
        data = await request.json()
        image_path = data.get("image_path", "")
        mask_data_b64 = data.get("mask_data", "")

        if not image_path or not mask_data_b64:
            return server.web.json_response({"status": "error", "message": "Missing parameters."}, status=400)

        filename = os.path.basename(image_path)
        name, _ = os.path.splitext(filename)
        mask_filename = f"{name}_mask.png"

        # Prefer saving next to the image; fall back to ComfyUI input dir.
        image_dir = os.path.dirname(image_path)
        if os.path.isdir(image_dir):
            mask_path = os.path.join(image_dir, mask_filename)
        else:
            mask_path = os.path.join(folder_paths.get_input_directory(), mask_filename)

        raw = _base64.b64decode(mask_data_b64.split(",")[1])
        img = Image.open(io.BytesIO(raw))
        if "A" in img.getbands():
            mask_img = img.split()[-1]
        else:
            mask_img = img.convert("L")

        # If the mask is completely empty, delete any existing mask file.
        extrema = mask_img.getextrema()
        if extrema and extrema[1] == 0:
            if os.path.exists(mask_path):
                os.remove(mask_path)
            return server.web.json_response({"status": "ok", "message": "Empty mask — file cleared."})

        mask_img.save(mask_path, "PNG")
        return server.web.json_response({"status": "ok", "mask_path": mask_path})
    except Exception as e:
        return server.web.json_response({"status": "error", "message": str(e)}, status=500)


@server.PromptServer.instance.routes.post("/meta-prompt-extractor/get-mask-path")
async def _mpe_get_mask_path(request):
    """Return the path to the mask file for a given image, if it exists."""
    try:
        data = await request.json()
        image_path = data.get("image_path", "")
        if not image_path:
            return server.web.json_response({"status": "error", "message": "Missing image_path."}, status=400)

        filename = os.path.basename(image_path)
        name, _ = os.path.splitext(filename)
        mask_filename = f"{name}_mask.png"

        # Check next to image first.
        candidate = os.path.join(os.path.dirname(image_path), mask_filename)
        if os.path.exists(candidate):
            return server.web.json_response({"status": "ok", "mask_path": candidate})

        # Fall back to ComfyUI input dir.
        input_candidate = os.path.join(folder_paths.get_input_directory(), mask_filename)
        if os.path.exists(input_candidate):
            return server.web.json_response({"status": "ok", "mask_path": input_candidate})

        return server.web.json_response({"status": "ok", "mask_path": None})
    except Exception as e:
        return server.web.json_response({"status": "error", "message": str(e)}, status=500)


NODE_CLASS_MAPPINGS = {
    "MetaPromptExtractor": MetaPromptExtractor
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MetaPromptExtractor": "Meta Prompt Extractor"
}