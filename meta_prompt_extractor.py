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

def _check_file_has_metadata(file_path):
    try:
        ext = os.path.splitext(file_path)[1].lower()
        if ext not in ['.png', '.jpg', '.jpeg', '.webp', '.json']:
            return False
        
        cache_key = file_path.replace(os.sep, '/')
        if cache_key in _file_metadata_cache:
            return True
        
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

class MetaPromptExtractor:
    @classmethod
    def INPUT_TYPES(cls):
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

    def extract(self, image="", unique_id=None,
                extra_pnginfo=None, **kwargs):
        positive_prompt = ""
        negative_prompt = ""
        image_tensor    = None

        file_path = (image or "").strip()
        if file_path in ("", "(none)"):
            return positive_prompt, negative_prompt, _placeholder_tensor()

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
            return positive_prompt, negative_prompt, _placeholder_tensor()

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

NODE_CLASS_MAPPINGS = {
    "MetaPromptExtractor": MetaPromptExtractor
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MetaPromptExtractor": "Meta Prompt Extractor"
}