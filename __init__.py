"""
MetaPromptExtractor — Standalone ComfyUI Custom Node
=====================================================
Drop this folder into ComfyUI/custom_nodes/ and restart.

No parent package required.  All dependencies are standard ComfyUI
(PIL, torch, numpy, aiohttp).

Node name  :  Meta Prompt Extractor
Category   :  utils
Find it by :  Right-click canvas → Add Node → utils → Meta Prompt Extractor
              OR use the search box and type "Meta Prompt"
"""

import os
import sys

_NODE_DIR = os.path.dirname(os.path.abspath(__file__))
if _NODE_DIR not in sys.path:
    sys.path.insert(0, _NODE_DIR)

try:
    from .meta_prompt_extractor import MetaPromptExtractor
    _IMPORT_OK = True
except Exception as _e:
    print(f"[MetaPromptExtractor] ERROR importing node: {_e}")
    import traceback; traceback.print_exc()
    _IMPORT_OK = False

NODE_CLASS_MAPPINGS = {"MetaPromptExtractor": MetaPromptExtractor} if _IMPORT_OK else {}
NODE_DISPLAY_NAME_MAPPINGS = {"MetaPromptExtractor": "Meta Prompt Extractor"} if _IMPORT_OK else {}

WEB_DIRECTORY = os.path.join(_NODE_DIR, "web")

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
