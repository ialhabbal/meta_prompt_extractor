# Meta Prompt Extractor

A ComfyUI custom node that extracts prompts from your images and workflow JSON files.

## Screenshots

### The Node
![meta_prompt_extractor](https://raw.githubusercontent.com/ialhabbal/meta_prompt_extractor/main/media/the_node.png)

### Browser Window
![meta_prompt_extractor](https://raw.githubusercontent.com/ialhabbal/meta_prompt_extractor/main/media/browser_window.png)

## What It Does

The **Meta Prompt Extractor** reads hidden metadata embedded in image files and workflow documents, then extracts:

- **Positive prompts** — The main text description used to generate an image
- **Negative prompts** — Text describing what to avoid in generation

## How the Prompt Is Found

Most tools just look for a `CLIPTextEncode` node and read its text field. That works for simple workflows but fails the moment a custom node, a chained text node, or a multi-stage pipeline is involved.

This node works differently:

1. **Finds the sampler first** — `KSampler`, `SamplerCustomAdvanced`, etc. — and uses it as the anchor point, because the sampler always knows what its positive and negative conditioning are
2. **Follows connections backwards** from the sampler's inputs, traversing through however many intermediate nodes there are, until it reaches the actual text
3. **Checks a registry of known custom nodes** so it knows exactly which field holds the text in nodes like `PromptManager` or `Prompt Verify`
4. **Falls back to a smart scan** if the chain leads somewhere unexpected — scanning all string values in the workflow and returning the most natural-language-looking result

## Installation

1. **Download the folder** into your ComfyUI `custom_nodes` directory:
   ```
   ComfyUI/
   └── custom_nodes/
       └── meta_prompt_extractor/  ← Put it here
   ```

2. **Restart ComfyUI** — The node will be automatically loaded

3. **No additional dependencies needed** — Uses only standard ComfyUI libraries (PIL, torch, numpy)

## How to Use

### Adding the Node

1. In ComfyUI, **right-click on the canvas** to open the node menu
2. Navigate to **`utils`** → **`Meta Prompt Extractor`**
3. Or use the search box and type **"Meta Prompt"**

### Basic Setup

The node has one main control:

| Control | Purpose |
|---------|----------|
| **Image path** | Select which file to extract metadata from (use the Browse button) |

### Using the Browse Button

1. Click the **📁 Browse** button next to the image path field
2. Navigate to any folder on your computer (any drive, any location)
3. Select an image or JSON file
4. The node will automatically load and extract the metadata

## Supported File Types

### Images
- **PNG** — Full support (most reliable, stores complete metadata)
- **JPG/JPEG** — Partial support (may have limited metadata)
- **WebP** — Partial support (depending on file creation tool)

### Workflows
- **JSON** — ComfyUI workflow files and API prompt files

## Output Ports

The node outputs three things you can connect to other nodes:

### 1. **Positive Prompt** (STRING)
The main text description. Example:
```
masterpiece, best quality, detailed portrait of a woman with long hair, 
soft lighting, bokeh background, sharp focus, professional photograph
```

### 2. **Negative Prompt** (STRING)
Text describing things to avoid. Example:
```
blurry, low quality, distorted, ugly, bad anatomy, watermark, signature
```

### 3. **Image** (IMAGE)
- For image files: Shows the actual image
- For JSON files: Shows a placeholder gray image

## Practical Examples

### Example 1: Extract Prompts from a Generated Image

**Goal:** You found a beautiful AI-generated image but forgot what prompt was used.

**Steps:**
1. Add a "Meta Prompt Extractor" node
2. Click Browse and select the image file
3. Connect the **Positive Prompt** output to a **Text Display** node
4. Run the workflow

**Result:** The original prompt appears in the text display!

```
Image File → Meta Prompt Extractor → [positive_prompt] → Text Display
```

### Example 2: Use Found Prompts to Create Similar Images

**Goal:** Reuse the exact settings from an existing image.

**Steps:**
1. Extract the prompts (positive and negative) using Meta Prompt Extractor
2. Feed the positive prompt into the **Positive Prompt** input of KSampler
3. Feed the negative prompt into the **Negative Prompt** input of KSampler
4. Generate new images with the same settings

```
Image File → Meta Prompt Extractor 
            ↓
    [positive_prompt] → KSampler
    [negative_prompt] → KSampler
    
→ Run generation
```

### Example 3: Load a Workflow JSON File

**Goal:** Recover workflow settings from a saved JSON file.

**Steps:**
1. Click Browse and select a `.json` workflow file
2. The node extracts all the generation parameters
3. The metadata appears in the outputs

**Note:** JSON files don't have an image preview, so the image port will show a gray placeholder.

---

### From Stable Diffusion / A1111 Images
- Positive and negative prompts

---

## Advanced Features

### A1111 to ComfyUI Conversion
When loading images from Stable Diffusion WebUI (A1111):
- Converts sampler names (e.g., "DPM++ 2M SDE" → `dpmpp_2m_sde`)
- Converts scheduler names (e.g., "Karras" → ComfyUI equivalent)

---

## Node Overview

| Setting | Type | Range | Default | Purpose |
|---------|------|-------|---------|---------|
| Image path | Combo | Any file | (none) | File to extract from |


| Output | Type | Returns |
|--------|------|---------|
| positive_prompt | STRING | Main text description |
| negative_prompt | STRING | Things to avoid || image | IMAGE | Image preview

---

License: MIT

---

Extracted and re-imagined by: ialhabbal

---

Credit: https://github.com/FranckyB/ComfyUI-Prompt-Manager

---