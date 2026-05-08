# Meta Prompt Extractor

A ComfyUI custom node that reads the prompts hidden inside your AI-generated images and workflow files, and hands them back to you as live node outputs — so you can reuse, remix, or route them anywhere in your workflow. It also ships with a full-featured file browser built directly into ComfyUI, giving you a complete image management workspace: browse any folder on any drive, preview thumbnails, read metadata at a glance, paint inpainting masks, and organise files into favourites — all without ever leaving the ComfyUI window.

## Screenshots

### The Node
![meta_prompt_extractor](https://raw.githubusercontent.com/ialhabbal/meta_prompt_extractor/main/media/the_node.png)

### Browse Files Floating Window
![meta_prompt_extractor](https://raw.githubusercontent.com/ialhabbal/meta_prompt_extractor/main/media/Browse_Files_floating_window.png)

### Image Right-Click Functions
![meta_prompt_extractor](https://raw.githubusercontent.com/ialhabbal/meta_prompt_extractor/main/media/image_right_click_functions.png)

### Mask Editor Window
![meta_prompt_extractor](https://raw.githubusercontent.com/ialhabbal/meta_prompt_extractor/main/media/mask_editor_window.png)

### Full File Picker for Copy/Move Functions
![meta_prompt_extractor](https://raw.githubusercontent.com/ialhabbal/meta_prompt_extractor/main/media/full_file_picker_for_copy_move_functions.png)

### Conditioning Input
![meta_prompt_extractor](https://raw.githubusercontent.com/ialhabbal/meta_prompt_extractor/main/media/conditioning_input_function.png)

### Conditioning Input Collapsed
![meta_prompt_extractor](https://raw.githubusercontent.com/ialhabbal/meta_prompt_extractor/main/media/conditioning_input_function1.png)

---

## What It Does

Point the node at any PNG, JPG, WebP, or JSON file and it outputs five things your workflow can use immediately:

- **Positive prompt** — The main generation text recovered from the file's embedded metadata
- **Negative prompt** — The negative text recovered from the same source
- **Image** — The image itself as a ComfyUI tensor, ready to pipe into any image node
- **Mask** — A mask you painted in the built-in Mask Editor, ready for inpainting
- **Path** — The full file path as a string, useful for logging or chaining into save nodes
- **Conditioning** — Accepts an input from previous ClipTextEncode positive. 
- **Conditioning Negative** — Accepts an input from previous ClipTextEncode Negative.

Beyond extraction, the node includes a self-contained file management system with these capabilities:

- **Full filesystem browser** — Navigate any folder on any drive on your machine using a floating, resizable window with breadcrumb navigation, back/forward history, drive switching, and a type-in path bar
- **Image thumbnail grid** — Preview images as thumbnails with adjustable grid density, lazy loading (only images on screen are fetched), and automatic dimension labels after load
- **Metadata detection** — Every thumbnail with embedded prompt data shows a 📋 badge so you can spot useful images at a glance before clicking them
- **Real-time search and filtering** — Filter the current folder by filename text or restrict the view to only files that carry metadata, with a live result count
- **Flexible sorting** — Order images by name, date modified, file size, pixel dimensions, or metadata presence
- **Multi-image selection** — Select images using checkboxes, Ctrl+click for individual toggles, or Shift+click to select an entire range at once
- **Metadata preview panel** — Click any image to read its full embedded metadata — prompts, workflow data, generation parameters — in a collapsible side panel, no workflow run required
- **Favorites system** — Save frequently used folders as one-click shortcuts in a resizable left sidebar; drag and drop selected images directly onto a favourite folder to move them there instantly
- **Right-click file management** — Rename, copy, move, delete, or open any file in Windows Explorer from a context menu; copy and move use a Windows-style folder picker dialog
- **Mask Editor** — A full paint tool for drawing inpainting masks directly on any image, with adjustable brush size, edge softness, invert, clear, pan, and zoom; masks are saved to disk and automatically reloaded
- **Drag and drop onto the node** — Drop an image file from your OS directly onto the node in ComfyUI to load it instantly, with metadata extracted from the raw file bytes before anything can strip it
- **Persistent window state** — The browser window remembers its size, position, last visited folder, last selected image, sidebar width, thumbnail size, and panel collapsed state between sessions

---

## How the Prompt Is Found

Most tools just look for a `CLIPTextEncode` node and read its text field. That works for simple workflows but fails the moment a custom node, a chained text node, or a multi-stage pipeline is involved.

This node works differently:

1. **Finds the sampler first** — `KSampler`, `SamplerCustomAdvanced`, etc. — and uses it as the anchor point, because the sampler always knows what its positive and negative conditioning are
2. **Follows connections backwards** from the sampler's inputs, traversing through however many intermediate nodes there are, until it reaches the actual text
3. **Checks a registry of known custom nodes** so it knows exactly which field holds the text in nodes like `PromptManager` or `Prompt Verify`
4. **Falls back to a smart scan** if the chain leads somewhere unexpected — scanning all string values in the workflow and returning the most natural-language-looking result

---

## Installation

1. **Download the folder** into your ComfyUI `custom_nodes` directory:
   ```
   ComfyUI/
   └── custom_nodes/
       └── meta_prompt_extractor/  ← Put it here
   ```

2. **Restart ComfyUI** — The node will be automatically loaded

3. **No additional dependencies needed** — Uses only standard ComfyUI libraries (PIL, torch, numpy)

---

## Adding the Node

1. In ComfyUI, **right-click on the canvas** to open the node menu
2. Navigate to **`utils`** → **`Meta Prompt Extractor`**
3. Or use the search box and type **"Meta Prompt"**

---

## The Node at a Glance

The node has one main control — the image path dropdown — and a Browse Files button beneath it. Below those controls, the node shows a live preview of the selected image. When you run the workflow, the node reads the image's embedded metadata and sends the extracted prompts to its five output ports.

| Output Port | Type | What It Returns |
|-------------|------|-----------------|
| `positive_prompt` | STRING | The main generation prompt |
| `negative_prompt` | STRING | The negative prompt |
| `image` | IMAGE | The image as a tensor (usable by any image node) |
| `mask` | MASK | A mask you painted in the Mask Editor (or empty if none) |
| `path` | STRING | The full file path of the selected image |

---

## Drag and Drop

The fastest way to load an image is to **drag it directly from your desktop or file explorer onto the node** in ComfyUI. Drop a PNG, JPG, JPEG, or WebP file and the node will:

1. Extract the metadata from the file's raw bytes immediately — before anything can strip it
2. Upload the file to ComfyUI's input directory automatically
3. Display the image preview on the node
4. Make the prompts available the next time you run the workflow

You do not need to open the Browse window at all when dragging and dropping.

---

## The Browse Files Window

Click the **📁 Browse Files** button to open the file browser. This is a full-featured window that lets you navigate your entire computer, preview images, read metadata, and manage files.

### Opening and Moving the Window

The window is **detached** — it floats freely over your ComfyUI canvas and does not block anything underneath. You can:

- **Move it** by clicking and dragging the title bar
- **Resize it** by dragging the grip dots in the bottom-right corner
- The window **remembers its size and position** between sessions, so it will reopen exactly where you left it

### Navigating to Folders

There are several ways to get to the folder you want:

**Using the breadcrumb bar at the top of the file list**
The current path is shown as clickable segments separated by `›` arrows. Click any segment to jump straight to that folder. For example, if you are in `C: › Users › John › Pictures › AI`, clicking `Pictures` takes you back there instantly.

**Typing a path directly**
Click anywhere on the breadcrumb bar and it switches to a text input. Type any absolute path (e.g. `D:\MyImages\batch01`) and press **Enter** to jump there immediately. Press **Escape** to go back to the breadcrumb view without navigating.

**Using the toolbar buttons**

| Button | What It Does |
|--------|--------------|
| ⬆ Up | Go to the parent folder |
| 🏠 | Go to your home directory |
| 💾 Drives | Show all available drives (C:\, D:\, etc.) |
| ⭐ | Add or remove the current folder from Favorites |

**Using the Favorites panel (left sidebar)**
The left panel shows all your saved favorite folders. Click any favorite to navigate there instantly. See the [Favorites](#favorites) section below for more.

### Remembers Where You Left Off

Every time you reopen the Browse window, it automatically returns to the **last folder you were in** and scrolls to the **last image you selected**, with that image highlighted and its checkbox ticked. You pick up exactly where you left off.

---

## The Image Grid

When you navigate to a folder containing images, they are displayed as thumbnails in a grid.

### Adjusting Thumbnail Size

Use the **🖼 slider** in the toolbar to control how many thumbnails appear per row. Slide left for larger thumbnails (2 per row), slide right for smaller ones (6 per row). The setting is remembered between sessions.

### Sorting Images

Use the **↕️ sort dropdown** to change the order of thumbnails:

| Sort Option | What It Does |
|-------------|--------------|
| Name | Alphabetical order (default) |
| Date Modified | Most recently changed files first |
| File Size | Largest files first |
| Dimensions | Largest images (by pixel count) first |
| Has Metadata | Images that contain embedded prompts appear first |

### The 📋 Metadata Badge

Any image that contains embedded metadata (prompts, workflow data) shows a small **📋** clipboard icon on its thumbnail. This makes it easy to spot at a glance which images have extractable prompts.

### Hovering Over a Thumbnail

Hovering over any image thumbnail reveals a subtle overlay showing the **file size** and **date modified** for that file.

---

## Filtering and Searching

### Text Search

Type in the **🔍 Filter** box to instantly narrow down the images shown. The filter matches against filenames in real time as you type. The result count (e.g. `12/48`) appears next to the search box so you always know how many files match.

### Metadata Quick Filter

Click the **📋 Metadata** button to show only files that contain embedded metadata. This is useful when you have a large folder of mixed images and want to find only the ones with extractable prompts. Click the button again to turn the filter off.

You can use the text filter and the metadata filter together at the same time.

---

## Selecting Images

### Single Selection

Click any thumbnail once to select it. The image gets a blue highlight border and its checkbox ticks. The full file path appears in the footer bar.

### Multi-Selection

You can select multiple images in three ways:

- **Checkbox** — Each thumbnail has a small checkbox in its top-left corner. Click the checkbox to add or remove that image from the selection without affecting any other selected images.
- **Ctrl + Click** — Hold **Ctrl** (or **Cmd** on Mac) while clicking thumbnails to add or remove individual images from the current selection.
- **Shift + Click** — Click one image, then hold **Shift** and click another to select the entire continuous range between them — just like selecting files in Windows Explorer.

Multi-selection is used for [moving images to a Favorite folder](#moving-images-to-a-favorite-folder) and for batch operations in the right-click menu.

### Confirming Your Selection

Once you have selected the image you want, click the **Select** button in the footer, or **double-click** any thumbnail, to load that image into the node and close the window.

---

## Metadata Panel

The **Metadata** panel on the right side of the Browse window automatically shows the embedded metadata of whatever image you click — no running required. It displays the positive prompt, negative prompt, workflow details, and any other metadata fields stored in the file.

### Collapsing the Panel

If you want more space for the image grid, click the **›** arrow button on the Metadata panel header to collapse it. The panel slides away and a vertical **📋 Metadata** tab appears on the right edge. Click that tab to expand the panel again.

The collapsed or expanded state is **remembered between sessions**.

---

## Favorites

The left sidebar is your Favorites panel — a list of folder shortcuts that let you jump to frequently used directories with a single click.

### Adding a Folder to Favorites

There are two ways to add a folder:

1. **Navigate to the folder** you want to save, then click the **⭐ star button** in the toolbar. The current folder is added to your Favorites immediately.
2. **Right-click any folder or file** in the file list and choose **Add to favorites** from the context menu. This adds the folder containing that item.

### Removing a Favorite

Right-click any item and choose **Remove from favorites** — or click the ⭐ button again while you are inside a favorited folder (it toggles).

### Resizing the Favorites Panel

Drag the **right edge** of the Favorites panel left or right to make it narrower or wider. The panel highlights in blue when you hover over the drag handle. Its width is remembered between sessions.

### Moving Images to a Favorite Folder

You can **drag and drop selected images directly onto a Favorite folder** in the left panel to move them there:

1. Select one or more images in the grid (single click, Ctrl+click, or Shift+click)
2. Drag any selected image from the grid
3. Drop it onto a folder in the Favorites panel

The images are **moved** (not copied) from their original location to the destination folder. The file list refreshes automatically. This is the fastest way to organise images into project folders.

---

## Right-Click Menu

Right-clicking any file or folder in the Browse window opens a context menu with the following options:

| Option | What It Does |
|--------|--------------|
| **Copy path** | Copies the full file path to your clipboard |
| **Open location in Explorer** | Opens the folder in Windows Explorer (or your OS file manager) |
| **Add / Remove from favorites** | Toggles the containing folder in your Favorites list |
| **Rename** | Renames the file (type a new name in the prompt that appears) |
| **Copy to…** | Opens a folder picker so you can copy the file to another location |
| **Move to…** | Opens a folder picker so you can move the file to another location |
| **Delete (to trash)** | Sends the file to the Recycle Bin after a confirmation prompt |
| **Open Mask Editor** | Opens the Mask Editor for that image (images only) |

### The Folder Picker (for Copy and Move)

When you choose **Copy to…** or **Move to…**, a Windows-style folder picker dialog opens. It has:

- A **left sidebar** with Quick Access shortcuts (Home, Desktop, Documents, Pictures, Downloads) and all available drives under "This PC"
- A **main panel** showing subfolders you can click to select or double-click to enter
- An **expand arrow (▸)** on each folder row that reveals its subfolders inline without navigating away
- **Back ◀ / Forward ▶ / Up ⬆** navigation buttons with full history
- A **breadcrumb bar** showing the current path as clickable segments
- A **path input** — click the breadcrumb bar to type any path directly

Single-click a folder to select it. Double-click to enter it. Click **Select Folder** to confirm.

---

## Mask Editor

The Mask Editor lets you paint a mask on top of any image. The mask is saved alongside the image and output through the node's **mask** port, so you can use it with inpainting nodes like KSampler with an inpainting model.

### Opening the Mask Editor

There are two ways to open it:

1. Select an image in the Browse window and click the **🎭 Mask Editor** button in the footer
2. Right-click any image thumbnail and choose **Open Mask Editor**

### Painting the Mask

| Action | How |
|--------|-----|
| **Draw (paint white)** | Left click and drag |
| **Erase** | Hold **Shift** + left click and drag |
| **Pan** | Middle mouse button + drag |
| **Zoom** | Mouse wheel |

The brush cursor shows as a circle that matches your current brush size. You can see your zoom level and the image dimensions in the info bar at the bottom left.

### Mask Controls

| Control | What It Does |
|---------|--------------|
| **Size slider** | Changes brush size (1–100 pixels) |
| **Softness slider** | Adds a feathered/blurred edge to brush strokes (0 = hard edge, 50 = very soft) |
| **Color dropdown** | Changes how the mask overlay is displayed: Difference, White, or Black |
| **Clear** | Removes the entire mask and starts fresh |
| **Invert** | Flips the mask — painted areas become unpainted and vice versa |

### Saving the Mask

Click **Save Mask**. The mask is saved as a PNG file alongside the original image and is automatically loaded the next time you open the Mask Editor for that image. The node's **mask** output port will carry this mask when the workflow runs.

Click **Cancel** to close without saving.

---

## Practical Examples

### Example 1: Extract Prompts from a Generated Image

**Goal:** You found a beautiful AI-generated image and want to know its prompt.

1. Add a **Meta Prompt Extractor** node to your workflow
2. Click **📁 Browse Files** and navigate to the image
3. Single-click the image to select it, then click **Select**
4. Connect the `positive_prompt` output to a **Show Text** node
5. Run the workflow — the original prompt appears in the text display

```
Image File → Meta Prompt Extractor → [positive_prompt] → Show Text
```

---

### Example 2: Reuse Prompts to Generate Similar Images

**Goal:** Reproduce an existing image with the same prompts.

1. Use Meta Prompt Extractor to select the source image
2. Connect `positive_prompt` → **Positive** input of your CLIPTextEncode
3. Connect `negative_prompt` → **Negative** input of your CLIPTextEncode
4. Connect `image` → a **VAE Encode** node if you want to img2img
5. Run generation

```
Image File → Meta Prompt Extractor
                ↓ positive_prompt → CLIPTextEncode (positive) → KSampler
                ↓ negative_prompt → CLIPTextEncode (negative) → KSampler
                ↓ image           → VAE Encode               → KSampler
```

---

### Example 3: Inpainting with a Painted Mask

**Goal:** Repaint part of an existing image using inpainting.

1. Select your image using **Browse Files**
2. Click **🎭 Mask Editor** in the footer
3. Paint white over the area you want to repaint
4. Click **Save Mask**
5. Connect the node's `image` output to your **VAE Encode (for inpainting)** node
6. Connect the `mask` output to the mask input of the same node
7. Run the workflow — only the painted area will be regenerated

```
Meta Prompt Extractor
    ↓ image → VAE Encode (inpaint) → KSampler (inpaint model)
    ↓ mask  → VAE Encode (inpaint)
```

---

### Example 4: Organise a Large Folder of Images

**Goal:** Sort through hundreds of images and move the best ones to a project folder.

1. Open Browse Files and navigate to your images folder
2. Click **📋 Metadata** filter to see only images with embedded data
3. Sort by **Has Metadata** to group them
4. ⭐ Add your destination project folder to Favorites
5. Select multiple images using Shift+click for ranges or Ctrl+click for individuals
6. Drag the selected images and drop them onto the destination folder in the Favorites panel — they move instantly

---

### Example 5: Extract Prompts from a JSON Workflow File

**Goal:** Recover the prompts used in a saved ComfyUI workflow.

1. Click **Browse Files** and navigate to your workflow JSON file
2. Select the `.json` file and click **Select**
3. The node extracts all generation parameters from the workflow graph
4. The `image` output will show a gray placeholder (JSON files have no image preview)
5. The `positive_prompt` and `negative_prompt` outputs carry the extracted text

---

### Example 6: Quick Load via Drag and Drop

**Goal:** Load an image from your desktop as fast as possible.

1. Simply **drag the image file from Windows Explorer** and drop it directly onto the Meta Prompt Extractor node in ComfyUI
2. The node loads the image, extracts metadata, and updates the preview — all in one step
3. Run the workflow

---

## Supported File Types

| Format | Support Level | Notes |
|--------|--------------|-------|
| PNG | Full | Most reliable — stores complete ComfyUI workflow and A1111 metadata |
| JPG / JPEG | Good | Reads EXIF and comment fields |
| WebP | Good | Reads embedded metadata where available |
| JSON | Full | ComfyUI workflow files and API prompt format |

---

## Output Ports Reference

| Port | Type | Description |
|------|------|-------------|
| `positive_prompt` | STRING | The main generation prompt extracted from the file |
| `negative_prompt` | STRING | The negative prompt extracted from the file |
| `image` | IMAGE | The image as a ComfyUI tensor — connect to any node that accepts IMAGE |
| `mask` | MASK | The painted mask from the Mask Editor — connect to VAE Encode or similar |
| `path` | STRING | The full absolute file path of the selected image |

---

## Tips and Tricks

**The window remembers everything.** Size, position, last folder, last selected image, which panel is expanded or collapsed, sidebar width, and thumbnail size are all saved automatically. Configure the window once, and it will always reopen exactly the way you left it.

**Use Favorites as project shortcuts.** Add one favorite folder per project and you can switch between large image libraries with a single click.

**The 📋 badge is your metadata detector.** Before you even click an image, the clipboard badge on the thumbnail tells you whether that file has extractable prompts. Files without it will still load and display, but their prompt outputs will be empty.

**Sort by "Has Metadata" when hunting for prompts.** This groups all metadata-bearing images at the top so you can find them quickly in a mixed folder.

**Drag to move, not just to select.** Once you have images selected, you can drag any one of them onto a Favorites folder to move all selected images at once. This is much faster than moving files one at a time.

**The path output is useful too.** Connect the `path` output to a text display or a save node if you want to log or reuse the source file path in your workflow.

---

## Advanced: A1111 / Stable Diffusion WebUI Images

When you load an image created with Stable Diffusion WebUI (A1111 or Forge), the node reads the `parameters` text field embedded in the PNG and converts it automatically. Sampler names are translated to their ComfyUI equivalents (e.g. `DPM++ 2M SDE` becomes `dpmpp_2m_sde`) and scheduler names are mapped similarly.

---

## Changelog

### 2.5.0
- Added two new Conditioning inputs for positive and negatie prompts from previous ClipTextEncode
- Added a on/off toggle to turn on/off the conditioninng functionality

### 2.0.0
- New Features Added

### 1.8.0
- Browse Files window now scrolls to and highlights the last selected image when reopened
- Fixed: mask and path output ports disappearing after ComfyUI restart

### 1.7.0
- Browse Files window remembers its previous state (size, position, panels) between sessions
- Favorites panel is now resizable by dragging its right edge
- Metadata panel is now collapsible — click › to hide it, click the tab to restore it
- Reopening the Browse window now returns to the last browsed folder

### 1.6.0
- Browse Files window is now detached and fully resizable
- Multi-select images with checkboxes, Ctrl+click, and Shift+click
- Drag selected images from the grid onto a Favorites folder to move them
- Copy/Move context menu items now open a Windows-style folder picker instead of a text box
- Reduced hover dark overlay on thumbnails by 70%
- Improved prompt extraction for drag-and-dropped images
- Added Rename, Copy to…, Move to…, and Delete (to trash) to right-click menu
- Added Mask Editor accessible from footer button and right-click menu
- Thumbnail size slider (2–6 per row)
- Sort images by name, date, size, dimensions, or metadata presence
- Filter by filename text and by metadata presence
- Lazy-loading thumbnails (only loads images as they scroll into view)
- Image dimensions displayed on each thumbnail after load

---

License: MIT

Developed by: ialhabbal
