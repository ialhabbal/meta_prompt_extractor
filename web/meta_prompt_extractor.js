/**
 * PromptExtractor Extension for ComfyUI
 * Adds image preview functionality for the extractor node
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
// file_browser.js not needed — self-contained browser below

// Placeholder image path - loaded from static PNG file

// ─────────────────────────────────────────────────────────────────────────────
// Filesystem helpers — replaces file_browser.js dependency
// ─────────────────────────────────────────────────────────────────────────────

function isAbsolutePath(p) {
    if (!p) return false;
    return /^([A-Za-z]:[\\\/]|\/)/.test(p);
}

function buildFileUrl(filename, viewType) {
    if (!filename || filename === '(none)') return null;
    if (isAbsolutePath(filename)) {
        return `/meta-prompt-extractor/serve-file?path=${encodeURIComponent(filename)}`;
    }
    let actualFilename = filename;
    let subfolder = '';
    if (filename.includes('/')) {
        const lastSlash = filename.lastIndexOf('/');
        subfolder = filename.substring(0, lastSlash);
        actualFilename = filename.substring(lastSlash + 1);
    }
    let url = `/view?filename=${encodeURIComponent(actualFilename)}&type=${viewType || 'input'}`;
    if (subfolder) url += `&subfolder=${encodeURIComponent(subfolder)}`;
    return url;
}

function _fileIcon(ext) {
    const map = { '.png':'🖼','.jpg':'🖼','.jpeg':'🖼','.webp':'🖼','.json':'📄' };
    return map[(ext||'').toLowerCase()] || '📄';
}

// ─────────────────────────────────────────────────────────────────────────────
// Context Menu System — Right-Click Power-User Features
// ─────────────────────────────────────────────────────────────────────────────

let _activeContextMenu = null; // Track active context menu to prevent duplicates

/**
 * Create and display a context menu for files/folders
 * Features: Copy path, Open in Explorer, Add/Remove from favorites
 */
function showContextMenu(event, filePath, isDir, getBookmarks, addBookmark, removeBookmark, renderBookmarks) {
    event.preventDefault();
    event.stopPropagation();
    
    // Close existing context menu
    if (_activeContextMenu) {
        _activeContextMenu.remove();
        _activeContextMenu = null;
    }
    
    const menu = document.createElement('div');
    menu.style.cssText = 'position:fixed;background:#1e2530;border:1px solid #3a4a5a;border-radius:6px;box-shadow:0 8px 32px rgba(0,0,0,0.8);z-index:10000;min-width:200px;overflow:hidden;';
    
    // Get page dimensions to keep menu in view
    const x = event.clientX;
    const y = event.clientY;
    const padding = 10;
    
    // Temporarily add to document to measure
    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    const finalX = Math.min(x, window.innerWidth - rect.width - padding);
    const finalY = Math.min(y, window.innerHeight - rect.height - padding);
    
    menu.style.left = finalX + 'px';
    menu.style.top = finalY + 'px';
    
    // Helper to create menu item
    const createMenuItem = (label, icon, callback) => {
        const item = document.createElement('div');
        item.style.cssText = 'display:flex;align-items:center;gap:10px;padding:10px 14px;cursor:pointer;color:#c8dff0;font-size:13px;user-select:none;transition:all 0.15s;';
        item.textContent = label;
        item.onmouseenter = () => item.style.background = 'rgba(255,255,255,0.08)';
        item.onmouseleave = () => item.style.background = 'transparent';
        item.onclick = (e) => {
            e.stopPropagation();
            callback();
            menu.remove();
            _activeContextMenu = null;
        };
        
        // Add icon before label if provided
        if (icon) {
            const iconSpan = document.createElement('span');
            iconSpan.textContent = icon;
            iconSpan.style.cssText = 'font-size:14px;';
            item.insertBefore(iconSpan, item.firstChild);
        }
        
        return item;
    };
    
    // ─── Menu Item 1: Copy Path to Clipboard ───
    menu.appendChild(createMenuItem(
        'Copy path',
        '📋',
        async () => {
            try {
                await navigator.clipboard.writeText(filePath);
                console.log("[MetaPromptExtractor] Copied to clipboard:", filePath);
            } catch (err) {
                console.warn("[MetaPromptExtractor] Failed to copy:", err);
            }
        }
    ));
    
    // ─── Menu Item 2: Open in Explorer ───
    menu.appendChild(createMenuItem(
        `Open ${isDir ? 'folder' : 'location'} in Explorer`,
        '🗂️',
        async () => {
            try {
                // For files, get parent directory; for dirs, use as-is
                let targetPath = filePath;
                if (!isDir) {
                    // Split by either forward or back slash, get all but last element
                    const parts = filePath.replace(/\\/g, '/').split('/');
                    targetPath = parts.slice(0, -1).join('/');
                    if (!targetPath) targetPath = '.'; // Fallback to current dir
                }
                
                console.log("[MetaPromptExtractor] Sending path to explorer:", targetPath);
                
                const response = await fetch('/meta-prompt-extractor/open-in-explorer', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: targetPath })
                });
                
                const result = await response.json();
                if (!response.ok) {
                    console.warn("[MetaPromptExtractor] Failed to open in explorer:", result.error);
                } else {
                    console.log("[MetaPromptExtractor] Opened in explorer:", result.message);
                }
            } catch (err) {
                console.warn("[MetaPromptExtractor] Error opening in explorer:", err);
            }
        }
    ));
    
    // ─── Menu Item 3: Add/Remove from Favorites ───
    const bookmarks = getBookmarks();
    const isBookmarked = bookmarks.some(b => b.path === filePath);
    const targetDir = isDir ? filePath : filePath.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
    const isTargetBookmarked = bookmarks.some(b => b.path === targetDir);
    
    menu.appendChild(createMenuItem(
        isTargetBookmarked ? 'Remove from favorites' : 'Add to favorites',
        isTargetBookmarked ? '⭐' : '☆',
        () => {
            if (isTargetBookmarked) {
                removeBookmark(targetDir);
                console.log("[MetaPromptExtractor] Removed from favorites:", targetDir);
            } else {
                addBookmark(targetDir);
                console.log("[MetaPromptExtractor] Added to favorites:", targetDir);
            }
            renderBookmarks();
        }
    ));
    
    // Close menu when clicking outside
    const closeMenu = (e) => {
        if (!menu.contains(e.target)) {
            menu.remove();
            _activeContextMenu = null;
            document.removeEventListener('mousedown', closeMenu);
        }
    };
    
    // Remove old position measurement and finalize
    document.removeEventListener('mousedown', closeMenu);
    document.addEventListener('mousedown', closeMenu);
    
    _activeContextMenu = menu;
}

async function createFileBrowserModal(currentFile, onSelect) {
    // ─── Bookmark Management ───
    const BOOKMARKS_KEY = "metaPromptExtractor_bookmarks";
    
    const getBookmarks = () => {
        try {
            const stored = localStorage.getItem(BOOKMARKS_KEY);
            return stored ? JSON.parse(stored) : [];
        } catch {
            return [];
        }
    };
    
    const saveBookmarks = (bookmarks) => {
        try {
            localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(bookmarks));
        } catch (e) {
            console.warn("[MetaPromptExtractor] Failed to save bookmarks:", e);
        }
    };
    
    const addBookmark = (path) => {
        const bookmarks = getBookmarks();
        if (!bookmarks.some(b => b.path === path)) {
            const name = path.split(/[/\\]/).filter(Boolean).pop() || path;
            bookmarks.push({ path, name });
            saveBookmarks(bookmarks);
        }
    };
    
    const removeBookmark = (path) => {
        const bookmarks = getBookmarks().filter(b => b.path !== path);
        saveBookmarks(bookmarks);
    };

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.72);z-index:9000;';

    // ── Initial size & centered position ──────────────────────────────────────
    const INIT_W = Math.min(900, Math.round(window.innerWidth  * 0.96));
    const INIT_H = Math.min(520, Math.round(window.innerHeight * 0.90));
    const INIT_X = Math.round((window.innerWidth  - INIT_W) / 2);
    const INIT_Y = Math.round((window.innerHeight - INIT_H) / 2);
    const MIN_W  = 420;
    const MIN_H  = 300;

    const modal = document.createElement('div');
    modal.style.cssText = `position:fixed;left:${INIT_X}px;top:${INIT_Y}px;width:${INIT_W}px;height:${INIT_H}px;background:#1e2530;border:1px solid #3a4a5a;border-radius:10px;display:flex;flex-direction:column;box-shadow:0 12px 48px rgba(0,0,0,0.6);font-family:sans-serif;overflow:hidden;z-index:9001;box-sizing:border-box;`;
    overlay.appendChild(modal);

    // Header
    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;gap:8px;padding:10px 14px;background:#161d27;border-bottom:1px solid #2e3d4e;flex-shrink:0;';
    const title = document.createElement('span');
    title.textContent = '📁 Browse Files';
    title.style.cssText = 'color:#d0e4f4;font-size:14px;font-weight:700;flex:1;';
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = 'background:none;border:none;color:#8aaccc;font-size:16px;cursor:pointer;padding:2px 6px;border-radius:4px;line-height:1;';
    header.appendChild(title); header.appendChild(closeBtn);
    modal.appendChild(header);

    // ── Drag-to-move — attached to header ────────────────────────────────────
    header.style.cursor = 'grab';
    header.addEventListener('mousedown', (mde) => {
        // Ignore clicks on the close button
        if (mde.target === closeBtn || closeBtn.contains(mde.target)) return;
        mde.preventDefault();
        header.style.cursor = 'grabbing';
        const startX = mde.clientX - modal.offsetLeft;
        const startY = mde.clientY - modal.offsetTop;
        const onMove = (mme) => {
            let nx = mme.clientX - startX;
            let ny = mme.clientY - startY;
            // Keep modal fully on-screen
            nx = Math.max(0, Math.min(nx, window.innerWidth  - modal.offsetWidth));
            ny = Math.max(0, Math.min(ny, window.innerHeight - modal.offsetHeight));
            modal.style.left = nx + 'px';
            modal.style.top  = ny + 'px';
        };
        const onUp = () => {
            header.style.cursor = 'grab';
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup',   onUp);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup',   onUp);
    });

    // ── Resize handle — bottom-right corner ──────────────────────────────────
    const resizeHandle = document.createElement('div');
    resizeHandle.style.cssText = 'position:absolute;bottom:0;right:0;width:18px;height:18px;cursor:se-resize;z-index:10;';
    // Subtle visual grip dots
    resizeHandle.innerHTML = `<svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg" style="display:block;opacity:0.35;">
        <circle cx="14" cy="14" r="1.5" fill="#9ab8d0"/>
        <circle cx="10" cy="14" r="1.5" fill="#9ab8d0"/>
        <circle cx="14" cy="10" r="1.5" fill="#9ab8d0"/>
    </svg>`;
    resizeHandle.addEventListener('mousedown', (mde) => {
        mde.preventDefault();
        mde.stopPropagation();
        const startX  = mde.clientX;
        const startY  = mde.clientY;
        const startW  = modal.offsetWidth;
        const startH  = modal.offsetHeight;
        const onMove  = (mme) => {
            const nw = Math.max(MIN_W, startW + (mme.clientX - startX));
            const nh = Math.max(MIN_H, startH + (mme.clientY - startY));
            // Keep within viewport
            const maxW = window.innerWidth  - modal.offsetLeft;
            const maxH = window.innerHeight - modal.offsetTop;
            modal.style.width  = Math.min(nw, maxW) + 'px';
            modal.style.height = Math.min(nh, maxH) + 'px';
        };
        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup',   onUp);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup',   onUp);
    });
    modal.appendChild(resizeHandle);

    // Main content area with sidebar
    const mainContent = document.createElement('div');
    mainContent.style.cssText = 'display:flex;flex:1;min-height:0;';

    // ─── Sidebar (Bookmarks) ───
    const sidebar = document.createElement('div');
    sidebar.style.cssText = 'width:160px;background:#161d27;border-right:1px solid #2e3d4e;overflow-y:auto;display:flex;flex-direction:column;flex-shrink:0;';
    
    const bookmarksTitle = document.createElement('div');
    bookmarksTitle.style.cssText = 'padding:10px 8px;font-size:11px;color:#7a9ab8;font-weight:700;text-transform:uppercase;border-bottom:1px solid #2e3d4e;flex-shrink:0;';
    bookmarksTitle.textContent = '⭐ Favorites';
    sidebar.appendChild(bookmarksTitle);
    
    const bookmarksList = document.createElement('div');
    bookmarksList.style.cssText = 'flex:1;overflow-y:auto;';
    sidebar.appendChild(bookmarksList);
    
    mainContent.appendChild(sidebar);

    // ─── Right panel (files) ───
    const rightPanel = document.createElement('div');
    rightPanel.style.cssText = 'display:flex;flex-direction:column;flex:1;min-width:0;border-right:1px solid #2e3d4e;';

    // ─── Breadcrumbs container ───
    const breadcrumbsContainer = document.createElement('div');
    breadcrumbsContainer.style.cssText = 'display:flex;align-items:center;gap:4px;padding:6px 12px;background:#1a2232;border-bottom:1px solid #2e3d4e;flex-shrink:0;overflow-x:auto;min-height:28px;';
    rightPanel.appendChild(breadcrumbsContainer);

    const renderBreadcrumbs = (path) => {
        breadcrumbsContainer.innerHTML = '';
        
        if (!path) {
            const homeSegment = document.createElement('div');
            homeSegment.style.cssText = 'display:flex;align-items:center;gap:4px;padding:4px 8px;background:#253040;border-radius:4px;cursor:pointer;color:#9bcce8;font-size:12px;white-space:nowrap;transition:all 0.15s;';
            homeSegment.textContent = '🏠 Home';
            homeSegment.title = 'Go to home directory';
            homeSegment.onmouseenter = () => homeSegment.style.background = '#2a4050';
            homeSegment.onmouseleave = () => homeSegment.style.background = '#253040';
            homeSegment.onclick = () => homeBtn.click();
            breadcrumbsContainer.appendChild(homeSegment);
            return;
        }
        
        // Normalize path separators and split
        const normalizedPath = path.replace(/\\/g, '/');
        let segments = normalizedPath.split('/').filter(s => s);
        
        // Add home/root indicator
        const isAbsolute = normalizedPath.startsWith('/') || /^[A-Za-z]:/.test(normalizedPath);
        
        // For Windows paths, remove drive letter from segments since we handle it separately
        if (isAbsolute && /^[A-Za-z]:/.test(normalizedPath)) {
            segments = segments.slice(1);
        }
        
        let rootSegment = document.createElement('div');
        rootSegment.style.cssText = 'display:flex;align-items:center;gap:4px;padding:4px 8px;background:#253040;border-radius:4px;cursor:pointer;color:#9bcce8;font-size:12px;white-space:nowrap;transition:all 0.15s;';
        
        if (isAbsolute && /^[A-Za-z]:/.test(normalizedPath)) {
            // Windows drive path
            rootSegment.textContent = normalizedPath.substring(0, 2).toUpperCase();
            rootSegment.title = 'Go to root';
            rootSegment.onclick = () => navigate(normalizedPath.substring(0, 2));
        } else if (isAbsolute) {
            // Unix absolute path
            rootSegment.textContent = '📁 /';
            rootSegment.title = 'Go to root';
            rootSegment.onclick = () => navigate('/');
        } else {
            // Relative path
            rootSegment.textContent = '🏠 Home';
            rootSegment.title = 'Go to home directory';
            rootSegment.onclick = () => homeBtn.click();
        }
        
        rootSegment.onmouseenter = () => rootSegment.style.background = '#2a4050';
        rootSegment.onmouseleave = () => rootSegment.style.background = '#253040';
        breadcrumbsContainer.appendChild(rootSegment);
        
        // Add separators and path segments
        let currentPathBuilding = isAbsolute && /^[A-Za-z]:/.test(normalizedPath) ? normalizedPath.substring(0, 2) : (isAbsolute ? '' : '');
        
        for (let i = 0; i < segments.length; i++) {
            const segment = segments[i];
            
            // Separator
            const separator = document.createElement('span');
            separator.textContent = '›';
            separator.style.cssText = 'color:#5a7a98;font-size:12px;padding:0 2px;flex-shrink:0;';
            breadcrumbsContainer.appendChild(separator);
            
            // Build path for this segment
            if (currentPathBuilding && !currentPathBuilding.endsWith('/')) {
                currentPathBuilding += '/';
            }
            currentPathBuilding += segment;
            const segmentPath = currentPathBuilding;
            const isLast = i === segments.length - 1;
            
            // Segment button
            const segmentBtn = document.createElement('div');
            segmentBtn.textContent = segment;
            segmentBtn.style.cssText = `display:flex;align-items:center;gap:4px;padding:4px 8px;background:${isLast?'#3a5a70':'#253040'};border-radius:4px;color:${isLast?'#c8dff0':'#9bcce8'};font-size:12px;cursor:${isLast?'default':'pointer'};white-space:nowrap;transition:all 0.15s;${isLast?'':'user-select:none;'}`;
            segmentBtn.title = isLast ? 'Current folder' : `Go to ${segment}`;
            
            if (!isLast) {
                segmentBtn.style.cursor = 'pointer';
                segmentBtn.onmouseenter = () => segmentBtn.style.background = '#2a4050';
                segmentBtn.onmouseleave = () => segmentBtn.style.background = '#253040';
                segmentBtn.onclick = () => navigate(segmentPath);
            }
            
            breadcrumbsContainer.appendChild(segmentBtn);
        }
    };

    // Path bar
    const pathBar = document.createElement('div');
    pathBar.style.cssText = 'display:flex;align-items:center;gap:6px;padding:7px 12px;background:#1a2232;border-bottom:1px solid #2e3d4e;flex-shrink:0;flex-wrap:wrap;';
    const pathInput = document.createElement('input');
    pathInput.type = 'text';
    pathInput.placeholder = 'Type a path and press Enter…';
    pathInput.style.cssText = 'flex:1;min-width:150px;background:#111820;border:1px solid #3a4a5a;border-radius:5px;color:#c8dff0;padding:5px 9px;font-size:12px;outline:none;';
    
    // ─── Search/Filter Box ───
    const searchContainer = document.createElement('div');
    searchContainer.style.cssText = 'display:flex;align-items:center;gap:4px;padding:0 8px;border-left:1px solid #2e3d4e;flex-shrink:0;';
    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.placeholder = '🔍 Filter…';
    searchInput.title = 'Search filenames and metadata keywords (real-time)';
    searchInput.style.cssText = 'background:#111820;border:1px solid #3a4a5a;border-radius:5px;color:#c8dff0;padding:5px 9px;font-size:12px;outline:none;width:140px;';
    const searchResultsLabel = document.createElement('span');
    searchResultsLabel.style.cssText = 'font-size:11px;color:#7a9ab8;white-space:nowrap;min-width:50px;';
    searchResultsLabel.textContent = '';
    searchContainer.appendChild(searchInput);
    searchContainer.appendChild(searchResultsLabel);
    const btnStyle = 'background:#253040;border:1px solid #3a4a5a;border-radius:5px;color:#9ab8d0;padding:5px 10px;font-size:12px;cursor:pointer;white-space:nowrap;';
    const upBtn   = Object.assign(document.createElement('button'), { textContent:'⬆ Up',   title:'Parent folder' });
    const homeBtn = Object.assign(document.createElement('button'), { textContent:'🏠',      title:'Home directory' });
    const rootBtn = Object.assign(document.createElement('button'), { textContent:'💾 Drives', title:'List drives' });
    const starBtn = Object.assign(document.createElement('button'), { textContent:'⭐',      title:'Add to favorites' });
    [upBtn, homeBtn, rootBtn, starBtn].forEach(b => b.style.cssText = btnStyle);
    pathBar.appendChild(pathInput); pathBar.appendChild(upBtn);
    pathBar.appendChild(homeBtn);   pathBar.appendChild(rootBtn);
    pathBar.appendChild(starBtn);
    pathBar.appendChild(searchContainer);
    
    // ─── Thumbnail size slider ───
    const sliderContainer = document.createElement('div');
    sliderContainer.style.cssText = 'display:flex;align-items:center;gap:6px;padding-left:8px;border-left:1px solid #2e3d4e;';
    const sliderLabel = document.createElement('span');
    sliderLabel.textContent = '🖼';
    sliderLabel.style.cssText = 'font-size:12px;color:#7a9ab8;flex-shrink:0;';
    const sizeSlider = document.createElement('input');
    sizeSlider.type = 'range';
    sizeSlider.min = '2';
    sizeSlider.max = '6';
    sizeSlider.value = '4';
    sizeSlider.title = 'Adjust thumbnail size (2-6 per row)';
    sizeSlider.style.cssText = 'width:80px;height:5px;border-radius:3px;background:#2e3d4e;outline:none;cursor:pointer;accent-color:#4a90d9;';
    sliderContainer.appendChild(sliderLabel);
    sliderContainer.appendChild(sizeSlider);
    pathBar.appendChild(sliderContainer);
    
    // ─── Quick Filter Buttons ───
    const filterButtonsContainer = document.createElement('div');
    filterButtonsContainer.style.cssText = 'display:flex;align-items:center;gap:4px;padding:0 8px;border-left:1px solid #2e3d4e;flex-shrink:0;';
    
    let activeFilters = {
        hasMetadata: false
    };
    
    const filterButtonStyle = (active) => 
        `background:${active?'#3a6a80':'#253040'};border:1px solid ${active?'#4a8aaa':'#3a4a5a'};border-radius:5px;color:${active?'#a8dff0':'#9ab8d0'};padding:5px 10px;font-size:11px;cursor:pointer;white-space:nowrap;transition:all 0.15s;`;
    
    const metaFilterBtn = document.createElement('button');
    metaFilterBtn.textContent = '📋 Metadata';
    metaFilterBtn.title = 'Show files with metadata only';
    metaFilterBtn.style.cssText = filterButtonStyle(false);
    
    const updateFilterButtonStyle = () => {
        metaFilterBtn.style.cssText = filterButtonStyle(activeFilters.hasMetadata);
    };
    
    metaFilterBtn.onclick = () => { activeFilters.hasMetadata = !activeFilters.hasMetadata; updateFilterButtonStyle(); if (currentBrowseData) renderDir(currentBrowseData); };
    
    filterButtonsContainer.appendChild(metaFilterBtn);
    pathBar.appendChild(filterButtonsContainer);

    // ─── Sort dropdown ───
    const sortContainer = document.createElement('div');
    sortContainer.style.cssText = 'display:flex;align-items:center;gap:6px;padding-left:8px;border-left:1px solid #2e3d4e;';
    const sortLabel = document.createElement('span');
    sortLabel.textContent = '↕️';
    sortLabel.style.cssText = 'font-size:12px;color:#7a9ab8;flex-shrink:0;';
    const sortSelect = document.createElement('select');
    sortSelect.title = 'Sort images by';
    sortSelect.style.cssText = 'background:#253040;border:1px solid #3a4a5a;border-radius:5px;color:#9ab8d0;padding:5px 8px;font-size:12px;cursor:pointer;outline:none;';
    const sortOptions = [
        { value: 'name', text: 'Name' },
        { value: 'date', text: 'Date Modified' },
        { value: 'size', text: 'File Size' },
        { value: 'dimensions', text: 'Dimensions' },
        { value: 'metadata', text: 'Has Metadata' }
    ];
    sortOptions.forEach(opt => {
        const option = document.createElement('option');
        option.value = opt.value;
        option.textContent = opt.text;
        sortSelect.appendChild(option);
    });
    sortSelect.value = 'name';
    sortContainer.appendChild(sortLabel);
    sortContainer.appendChild(sortSelect);
    pathBar.appendChild(sortContainer);
    
    rightPanel.appendChild(pathBar);

    // File list
    const listContainer = document.createElement('div');
    listContainer.style.cssText = 'flex:1;overflow-y:auto;padding:4px 0;min-height:0;';
    rightPanel.appendChild(listContainer);
    
    mainContent.appendChild(rightPanel);

    // ─── Metadata Panel (Right side) ───
    const metadataPanel = document.createElement('div');
    metadataPanel.style.cssText = 'width:280px;background:#161d27;border-left:1px solid #2e3d4e;overflow-hidden;display:flex;flex-direction:column;flex-shrink:0;';
    
    const metadataHeader = document.createElement('div');
    metadataHeader.style.cssText = 'padding:10px 12px;font-size:12px;color:#7a9ab8;font-weight:700;text-transform:uppercase;border-bottom:1px solid #2e3d4e;flex-shrink:0;';
    metadataHeader.textContent = '📋 Metadata';
    metadataPanel.appendChild(metadataHeader);
    
    const metadataContent = document.createElement('div');
    metadataContent.style.cssText = 'flex:1;overflow-y:auto;padding:10px 12px;font-size:12px;';
    metadataPanel.appendChild(metadataContent);
    
    mainContent.appendChild(metadataPanel);
    modal.appendChild(mainContent);

    // Footer
    const footer = document.createElement('div');
    footer.style.cssText = 'display:flex;align-items:center;gap:8px;padding:10px 14px;background:#161d27;border-top:1px solid #2e3d4e;flex-shrink:0;';
    const selectedLabel = document.createElement('span');
    selectedLabel.style.cssText = 'flex:1;color:#7a9ab8;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    selectedLabel.textContent = currentFile ? `Selected: ${currentFile}` : 'No file selected';
    const selectBtn = document.createElement('button');
    selectBtn.textContent = 'Select'; selectBtn.disabled = true;
    selectBtn.style.cssText = 'background:#2a6ea6;border:none;border-radius:6px;color:#fff;padding:7px 20px;font-size:13px;cursor:pointer;font-weight:600;opacity:0.5;';
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = 'background:#2a3040;border:1px solid #3a4a5a;border-radius:6px;color:#9ab8d0;padding:7px 16px;font-size:13px;cursor:pointer;';
    footer.appendChild(selectedLabel); footer.appendChild(cancelBtn); footer.appendChild(selectBtn);
    modal.appendChild(footer);

    let currentPath = null;
    let selectedPath = (currentFile && isAbsolutePath(currentFile)) ? currentFile : null;
    let currentBrowseData = null;
    if (selectedPath) { selectBtn.disabled = false; selectBtn.style.opacity = '1'; }

    // ─── Metadata Extraction Functions ───
    const extractMetadataFromBlob = async (blob, filename) => {
        const ext = filename.split('.').pop().toLowerCase();
        const arrayBuffer = await blob.arrayBuffer();
        const uint8Array = new Uint8Array(arrayBuffer);
        
        if (['png'].includes(ext)) {
            return extractPNGMetadata(uint8Array);
        } else if (['jpg', 'jpeg'].includes(ext)) {
            return extractJPEGMetadata(uint8Array);
        } else if (['webp'].includes(ext)) {
            return extractWebPMetadata(uint8Array);
        }
        return null;
    };
    
    const extractPNGMetadata = (uint8Array) => {
        const dataView = new DataView(uint8Array.buffer);
        if (dataView.getUint32(0) !== 0x89504E47 || dataView.getUint32(4) !== 0x0D0A1A0A) {
            return null;
        }
        let prompt = null;
        let workflow = null;
        let parameters = null;
        let offset = 8;
        
        while (offset < uint8Array.length - 12) {
            const chunkLength = dataView.getUint32(offset);
            const chunkType = String.fromCharCode(uint8Array[offset + 4], uint8Array[offset + 5], uint8Array[offset + 6], uint8Array[offset + 7]);
            
            if (chunkType === 'tEXt' || chunkType === 'iTXt') {
                const chunkData = uint8Array.slice(offset + 8, offset + 8 + chunkLength);
                const decoder = new TextDecoder();
                const text = decoder.decode(chunkData);
                const nullIdx = text.indexOf('\x00');
                const key = text.substring(0, nullIdx > 0 ? nullIdx : text.length);
                const value = nullIdx > 0 ? text.substring(nullIdx + 1) : '';
                
                if (key === 'prompt') prompt = value;
                else if (key === 'workflow') workflow = value;
                else if (key === 'parameters') parameters = value;
            }
            offset += 12 + chunkLength;
        }
        
        return { prompt, workflow, parameters, type: 'PNG' };
    };
    
    const extractJPEGMetadata = (uint8Array) => {
        if (uint8Array[0] !== 0xFF || uint8Array[1] !== 0xD8) return null;
        let offset = 2;
        let prompt = null;
        let workflow = null;
        let parameters = null;
        
        while (offset < uint8Array.length) {
            if (uint8Array[offset] !== 0xFF) break;
            const marker = uint8Array[offset + 1];
            const length = (uint8Array[offset + 2] << 8) | uint8Array[offset + 3];
            
            if (marker === 0xE1 || marker === 0xFE) {
                const segmentData = uint8Array.slice(offset + 4, offset + 2 + length);
                const decoder = new TextDecoder();
                const text = decoder.decode(segmentData);
                
                if (text.includes('prompt')) {
                    const match = text.match(/prompt[":=\s]+([^,}\n]*)/i);
                    if (match) prompt = match[1].trim().replace(/^["']|["']$/g, '');
                }
                if (text.includes('workflow')) {
                    const match = text.match(/workflow[":=\s]+([^,}\n]*)/i);
                    if (match) workflow = match[1].trim().replace(/^["']|["']$/g, '');
                }
            }
            
            offset += 2 + length;
        }
        
        return prompt || workflow ? { prompt, workflow, parameters, type: 'JPEG' } : null;
    };
    
    const extractWebPMetadata = (uint8Array) => {
        if (String.fromCharCode(uint8Array[0], uint8Array[1], uint8Array[2], uint8Array[3]) !== 'RIFF') return null;
        if (String.fromCharCode(uint8Array[8], uint8Array[9], uint8Array[10], uint8Array[11]) !== 'WEBP') return null;
        
        let offset = 12;
        let prompt = null;
        let workflow = null;
        let parameters = null;
        
        while (offset < uint8Array.length - 8) {
            const chunkId = String.fromCharCode(uint8Array[offset], uint8Array[offset + 1], uint8Array[offset + 2], uint8Array[offset + 3]);
            const chunkSize = (uint8Array[offset + 7] << 24) | (uint8Array[offset + 6] << 16) | (uint8Array[offset + 5] << 8) | uint8Array[offset + 4];
            
            if (chunkId === 'EXIF') {
                const chunkData = uint8Array.slice(offset + 8, offset + 8 + chunkSize);
                const decoder = new TextDecoder();
                const text = decoder.decode(chunkData);
                
                if (text.includes('prompt')) {
                    const match = text.match(/prompt[":=\s]+([^,}\n]*)/i);
                    if (match) prompt = match[1].trim().replace(/^["']|["']$/g, '');
                }
            }
            
            offset += 8 + chunkSize;
        }
        
        return prompt ? { prompt, workflow, parameters, type: 'WebP' } : null;
    };
    
    const displayMetadata = async (filePath) => {
        metadataContent.innerHTML = '<div style="color:#7a9ab8;font-size:11px;padding:8px;">Loading metadata…</div>';
        
        try {
            const filename = filePath.split(/[/\\]/).pop();
            const ext = filename.split('.').pop().toLowerCase();
            
            if (!['png', 'jpg', 'jpeg', 'webp'].includes(ext)) {
                metadataContent.innerHTML = '<div style="color:#7a9ab8;font-size:11px;padding:8px;">No metadata for this file type</div>';
                return;
            }
            
            let blob;
            if (isAbsolutePath(filePath)) {
                const resp = await fetch(`/meta-prompt-extractor/serve-file?path=${encodeURIComponent(filePath)}`);
                if (!resp.ok) throw new Error('Failed to fetch file');
                blob = await resp.blob();
            } else {
                const parts = filePath.split('/');
                const fname = parts[parts.length - 1];
                const subfolder = parts.slice(0, -1).join('/');
                let url = `/view?filename=${encodeURIComponent(fname)}&type=input`;
                if (subfolder) url += `&subfolder=${encodeURIComponent(subfolder)}`;
                const resp = await fetch(url);
                if (!resp.ok) throw new Error('Failed to fetch file');
                blob = await resp.blob();
            }
            
            const metadata = await extractMetadataFromBlob(blob, filename);
            
            if (!metadata) {
                metadataContent.innerHTML = '<div style="color:#7a9ab8;font-size:11px;padding:8px;">No metadata found</div>';
                return;
            }
            
            metadataContent.innerHTML = '';
            
            // File type
            const typeDiv = document.createElement('div');
            typeDiv.style.cssText = 'margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid #2e3d4e;';
            const typeLabel = document.createElement('div');
            typeLabel.style.cssText = 'font-size:10px;color:#5a7a98;text-transform:uppercase;margin-bottom:4px;';
            typeLabel.textContent = '📄 File Type';
            typeDiv.appendChild(typeLabel);
            const typeValue = document.createElement('div');
            typeValue.style.cssText = 'font-size:11px;color:#c8dff0;';
            typeValue.textContent = metadata.type || ext.toUpperCase();
            typeDiv.appendChild(typeValue);
            metadataContent.appendChild(typeDiv);
            
            // Parse metadata for better handling of A1111 parameters
            let promptText = '';
            let negativePromptText = '';
            let workflowText = '';
            let hasContent = false;
            
            // Handle string-based metadata (from PNG text chunks)
            if (typeof metadata.prompt === 'string') {
                promptText = metadata.prompt;
                hasContent = true;
            } else if (typeof metadata.prompt === 'object') {
                // Handle JSON-based prompt data
                if (metadata.prompt.prompt || metadata.prompt.positive) {
                    promptText = metadata.prompt.prompt || metadata.prompt.positive || '';
                }
                if (metadata.prompt.negative_prompt || metadata.prompt.negative) {
                    negativePromptText = metadata.prompt.negative_prompt || metadata.prompt.negative || '';
                }
                hasContent = true;
            }
            
            // Handle A1111 parameters format
            if (metadata.parameters && typeof metadata.parameters === 'string') {
                // Parse A1111 parameters to extract negative prompt
                const params = metadata.parameters;
                const negMatch = params.match(/Negative prompt:\s*([^\n]+?)(?:\n|Steps:)/);
                if (negMatch) {
                    negativePromptText = negMatch[1].trim();
                    hasContent = true;
                }
                // Extract positive prompt if not already set
                if (!promptText) {
                    const parts = params.split(/Negative prompt:/i);
                    promptText = parts[0].trim();
                    hasContent = true;
                }
            }
            
            // Positive Prompt
            if (promptText) {
                const promptDiv = document.createElement('div');
                promptDiv.style.cssText = 'margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid #2e3d4e;';
                const promptLabel = document.createElement('div');
                promptLabel.style.cssText = 'font-size:10px;color:#5a9a8;text-transform:uppercase;margin-bottom:4px;';
                promptLabel.textContent = '✨ Positive Prompt';
                promptDiv.appendChild(promptLabel);
                const promptValue = document.createElement('div');
                promptValue.style.cssText = 'font-size:11px;color:#a8dff0;line-height:1.4;word-wrap:break-word;white-space:pre-wrap;max-height:100px;overflow-y:auto;';
                promptValue.textContent = promptText;
                promptDiv.appendChild(promptValue);
                metadataContent.appendChild(promptDiv);
            }
            
            // Negative Prompt
            if (negativePromptText) {
                const negDiv = document.createElement('div');
                negDiv.style.cssText = 'margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid #2e3d4e;';
                const negLabel = document.createElement('div');
                negLabel.style.cssText = 'font-size:10px;color:#c97a7a;text-transform:uppercase;margin-bottom:4px;';
                negLabel.textContent = '⛔ Negative Prompt';
                negDiv.appendChild(negLabel);
                const negValue = document.createElement('div');
                negValue.style.cssText = 'font-size:11px;color:#d4a0a0;line-height:1.4;word-wrap:break-word;white-space:pre-wrap;max-height:100px;overflow-y:auto;';
                negValue.textContent = negativePromptText;
                negDiv.appendChild(negValue);
                metadataContent.appendChild(negDiv);
            }
            
            // Workflow (if present)
            if (metadata.workflow) {
                const workflowDiv = document.createElement('div');
                workflowDiv.style.cssText = 'margin-bottom:12px;';
                const workflowLabel = document.createElement('div');
                workflowLabel.style.cssText = 'font-size:10px;color:#5a7a98;text-transform:uppercase;margin-bottom:4px;';
                workflowLabel.textContent = '🔗 Workflow Info';
                workflowDiv.appendChild(workflowLabel);
                
                // Try to parse workflow JSON for better display
                let workflowObj = metadata.workflow;
                if (typeof metadata.workflow === 'string') {
                    try {
                        workflowObj = JSON.parse(metadata.workflow);
                    } catch (e) {
                        // Keep as string if not valid JSON
                    }
                }
                
                const workflowValue = document.createElement('div');
                workflowValue.style.cssText = 'font-size:10px;color:#7a9ab8;background:#111820;padding:6px;border-radius:3px;max-height:80px;overflow-y:auto;word-break:break-all;';
                
                if (typeof workflowObj === 'object') {
                    const nodeCount = workflowObj.nodes ? Object.keys(workflowObj.nodes).length : 0;
                    const lastNodeId = workflowObj.last_node_id || '?';
                    workflowValue.textContent = `Nodes: ${nodeCount}, Last ID: ${lastNodeId}`;
                } else {
                    workflowValue.textContent = String(metadata.workflow).substring(0, 200) + (String(metadata.workflow).length > 200 ? '…' : '');
                }
                
                workflowDiv.appendChild(workflowValue);
                metadataContent.appendChild(workflowDiv);
            }
            
            if (!hasContent && !metadata.workflow) {
                metadataContent.innerHTML = '<div style="color:#7a9ab8;font-size:11px;padding:8px;">No prompts found in image metadata</div>';
            }
        } catch (err) {
            console.warn("[MetaPromptExtractor] Metadata extraction error:", err);
            metadataContent.innerHTML = `<div style="color:#e07070;font-size:11px;padding:8px;">Error: ${err.message}</div>`;
        }
    };
    
    const clearMetadata = () => {
        metadataContent.innerHTML = '<div style="color:#5a7a98;font-size:11px;padding:12px;text-align:center;line-height:1.5;">👇 Select an image to preview its metadata:<br/><br/><span style="font-size:10px;color:#4a6a88;">• Positive prompt<br/>• Negative prompt<br/>• Workflow info</span></div>';
    };

    const setLoading = () => { listContainer.innerHTML = '<div style="color:#7a9ab8;font-size:13px;padding:20px;text-align:center;">Loading…</div>'; };

    // ─── Filter/Search Functionality ───
    let filterDebounceTimer = null;
    let cachedMetadata = {}; // Cache metadata for search performance
    let currentFilter = '';
    
    const parseFilterQuery = (query) => {
        // Allow searching for keywords separated by spaces or commas
        return query.trim().toLowerCase().split(/[\s,]+/).filter(q => q.length > 0);
    };
    
    const matchesFilter = (entry, filterTerms) => {
        if (filterTerms.length === 0) return true;
        
        // Check filename
        const nameLower = (entry.name || '').toLowerCase();
        const filenameMatch = filterTerms.some(term => nameLower.includes(term));
        
        // Check cached metadata (if available)
        if (cachedMetadata[entry.path]) {
            const metadata = cachedMetadata[entry.path];
            const metadataText = `${metadata.prompt || ''} ${metadata.parameters || ''}`.toLowerCase();
            const metadataMatch = filterTerms.some(term => metadataText.includes(term));
            return filenameMatch || metadataMatch;
        }
        
        return filenameMatch;
    };
    
    const updateFilterResults = async () => {
        const filterTerms = parseFilterQuery(searchInput.value);
        currentFilter = searchInput.value.trim();
        
        if (currentBrowseData) {
            // Pre-cache metadata for image files (limited to improve performance)
            const imageExts = ['png', 'jpg', 'jpeg', 'webp'];
            const imagesToCache = currentBrowseData.entries
                .filter(e => e.type === 'file' && imageExts.includes((e.ext || '').substring(1).toLowerCase()))
                .slice(0, 20); // Limit to first 20 images for performance
            
            for (const entry of imagesToCache) {
                if (!cachedMetadata[entry.path] && !cachedMetadata[entry.path + '_loading']) {
                    cachedMetadata[entry.path + '_loading'] = true;
                    try {
                        let blob;
                        if (isAbsolutePath(entry.path)) {
                            const resp = await fetch(`/meta-prompt-extractor/serve-file?path=${encodeURIComponent(entry.path)}`);
                            if (resp.ok) blob = await resp.blob();
                        } else {
                            const parts = entry.path.split('/');
                            const fname = parts[parts.length - 1];
                            const subfolder = parts.slice(0, -1).join('/');
                            let url = `/view?filename=${encodeURIComponent(fname)}&type=input`;
                            if (subfolder) url += `&subfolder=${encodeURIComponent(subfolder)}`;
                            const resp = await fetch(url);
                            if (resp.ok) blob = await resp.blob();
                        }
                        
                        if (blob) {
                            const metadata = await extractMetadataFromBlob(blob, entry.name);
                            cachedMetadata[entry.path] = metadata || {};
                        }
                    } catch (e) {
                        cachedMetadata[entry.path] = {};
                    }
                    delete cachedMetadata[entry.path + '_loading'];
                }
            }
            
            renderDir(currentBrowseData);
        }
    };
    
    searchInput.oninput = () => {
        clearTimeout(filterDebounceTimer);
        filterDebounceTimer = setTimeout(updateFilterResults, 200); // Debounce 200ms
    };

    const sortImages = (images, sortMethod) => {
        const sorted = [...images];
        
        switch(sortMethod) {
            case 'name':
                sorted.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
                break;
            case 'date':
                sorted.sort((a, b) => {
                    const aDate = new Date((a.mtime || a.modified || a.mtime || 0) * 1000).getTime();
                    const bDate = new Date((b.mtime || b.modified || b.mtime || 0) * 1000).getTime();
                    return bDate - aDate; // Newest first
                });
                break;
            case 'size':
                sorted.sort((a, b) => {
                    const aSize = a.size || 0;
                    const bSize = b.size || 0;
                    return bSize - aSize; // Largest first
                });
                break;
            case 'dimensions':
                sorted.sort((a, b) => {
                    const aArea = ((a.width || 0) * (a.height || 0)) || 0;
                    const bArea = ((b.width || 0) * (b.height || 0)) || 0;
                    return bArea - aArea; // Largest resolution first
                });
                break;
            case 'metadata':
                sorted.sort((a, b) => {
                    // Files with metadata first, then by name
                    if ((a.has_metadata || false) !== (b.has_metadata || false)) {
                        return (b.has_metadata || false) ? 1 : -1;
                    }
                    return (a.name || '').localeCompare(b.name || '');
                });
                break;
            default:
                break;
        }
        
        return sorted;
    };

    const renderDir = (data) => {
        currentBrowseData = data;
        listContainer.innerHTML = '';
        if (!data.entries || data.entries.length === 0) {
            listContainer.innerHTML = '<div style="color:#7a9ab8;font-size:13px;padding:20px;text-align:center;">Empty folder</div>';
            return;
        }
        
        // Parse filter query
        const filterTerms = parseFilterQuery(currentFilter);
        
        // Separate images from other files
        const imageExts = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'];
        const imageFiles = data.entries.filter(e => {
            if (e.type !== 'file') return false;
            // Handle both '.png' and 'png' format
            let ext = (e.ext || '').toLowerCase();
            if (ext.startsWith('.')) ext = ext.substring(1);
            return imageExts.includes(ext);
        });
        const otherFiles = data.entries.filter(e => {
            if (e.type !== 'file') return true;  // Include directories
            // Handle both '.png' and 'png' format
            let ext = (e.ext || '').toLowerCase();
            if (ext.startsWith('.')) ext = ext.substring(1);
            return !imageExts.includes(ext);
        });
        
        // Apply text search and quick filters to images
        let filteredImageFiles = imageFiles.filter(e => {
            if (!matchesFilter(e, filterTerms)) return false;
            if (activeFilters.hasMetadata && !e.has_metadata) return false;
            return true;
        });
        
        // Apply quick filters to other files
        let filteredOtherFiles = otherFiles.filter(e => {
            if (e.type === 'dir') return true; // Always show directories for navigation
            if (!matchesFilter(e, filterTerms)) return false;
            if (activeFilters.hasMetadata && !e.has_metadata) return false;
            return true;
        });
        
        // Update filter results label
        if (filterTerms.length > 0) {
            const totalResults = filteredImageFiles.length + filteredOtherFiles.filter(e => e.type === 'file').length;
            const totalItems = imageFiles.length + otherFiles.filter(e => e.type === 'file').length;
            searchResultsLabel.textContent = `${totalResults}/${totalItems}`;
            searchResultsLabel.style.color = totalResults === 0 ? '#e07070' : '#7a9ab8';
        } else {
            searchResultsLabel.textContent = '';
        }
        
        console.log("[MetaPromptExtractor] File browser: found", filteredImageFiles.length, "filtered images and", filteredOtherFiles.length, "filtered other files");
        
        // Render directories first
        for (const entry of filteredOtherFiles.filter(e => e.type === 'dir')) {
            const row = document.createElement('div');
            row.style.cssText = `display:flex;align-items:center;gap:8px;padding:6px 14px;cursor:pointer;user-select:none;`;
            row.onmouseenter = () => { row.style.background = 'rgba(255,255,255,0.04)'; };
            row.onmouseleave = () => { row.style.background = 'transparent'; };
            const icon = document.createElement('span');
            icon.textContent = '📁';
            icon.style.cssText = 'font-size:15px;flex-shrink:0;width:20px;text-align:center;';
            const nameSpan = document.createElement('span');
            nameSpan.textContent = entry.name;
            nameSpan.style.cssText = `flex:1;font-size:13px;color:#9bcce8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`;
            row.appendChild(icon); row.appendChild(nameSpan);
            row.onclick = () => navigate(entry.path);
            row.oncontextmenu = (e) => showContextMenu(e, entry.path, true, getBookmarks, addBookmark, removeBookmark, renderBookmarks);
            listContainer.appendChild(row);
        }
        
        // Render non-image files
        for (const entry of filteredOtherFiles.filter(e => e.type === 'file')) {
            const isSelected = entry.path === selectedPath;
            const row = document.createElement('div');
            row.style.cssText = `display:flex;align-items:center;gap:8px;padding:6px 14px;cursor:pointer;user-select:none;background:${isSelected?'rgba(42,110,166,0.35)':'transparent'};border-left:3px solid ${isSelected?'#2a6ea6':'transparent'};`;
            row.onmouseenter = () => { if (entry.path !== selectedPath) row.style.background = 'rgba(255,255,255,0.04)'; };
            row.onmouseleave = () => { if (entry.path !== selectedPath) row.style.background = 'transparent'; };
            const icon = document.createElement('span');
            icon.textContent = _fileIcon(entry.ext || '');
            icon.style.cssText = 'font-size:15px;flex-shrink:0;width:20px;text-align:center;';
            
            // File info container
            const infoContainer = document.createElement('div');
            infoContainer.style.cssText = 'display:flex;flex-direction:column;flex:1;min-width:0;';
            
            // Filename with metadata indicator
            const nameRow = document.createElement('div');
            nameRow.style.cssText = 'display:flex;align-items:center;gap:6px;';
            const nameSpan = document.createElement('span');
            nameSpan.textContent = entry.name;
            nameSpan.style.cssText = `flex:1;font-size:13px;color:#c8dff0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`;
            nameRow.appendChild(nameSpan);
            
            if (entry.has_metadata) {
                const metaIndicator = document.createElement('span');
                metaIndicator.textContent = '📋';
                metaIndicator.title = 'Has metadata';
                metaIndicator.style.cssText = 'font-size:11px;flex-shrink:0;';
                nameRow.appendChild(metaIndicator);
            }
            
            infoContainer.appendChild(nameRow);
            
            // File details (size, date)
            if (entry.size !== undefined || entry.mtime !== undefined) {
                const detailsSpan = document.createElement('span');
                let details = [];
                
                if (entry.size !== undefined) {
                    const sizeStr = entry.size < 1024 ? entry.size + 'B' :
                                   entry.size < 1024*1024 ? (entry.size/1024).toFixed(1) + 'KB' :
                                   (entry.size/(1024*1024)).toFixed(1) + 'MB';
                    details.push(sizeStr);
                }
                
                if (entry.mtime) {
                    const date = new Date(entry.mtime * 1000);
                    const now = new Date();
                    const diffMs = now - date;
                    const diffDays = Math.floor(diffMs / (1000*60*60*24));
                    let timeStr;
                    if (diffDays === 0) {
                        timeStr = date.toLocaleTimeString('en-US', {hour: '2-digit', minute: '2-digit'});
                    } else if (diffDays === 1) {
                        timeStr = 'Yesterday';
                    } else if (diffDays < 7) {
                        timeStr = diffDays + 'd ago';
                    } else {
                        timeStr = date.toLocaleDateString('en-US', {month: 'short', day: 'numeric'});
                    }
                    details.push(timeStr);
                }
                
                detailsSpan.textContent = details.join(' • ');
                detailsSpan.style.cssText = 'font-size:11px;color:#7a9ab8;';
                infoContainer.appendChild(detailsSpan);
            }
            
            row.appendChild(icon);
            row.appendChild(infoContainer);
            row.onclick = () => {
                selectedPath = entry.path;
                selectedLabel.textContent = `Selected: ${entry.path}`;
                selectBtn.disabled = false; selectBtn.style.opacity = '1';
                renderDir(currentBrowseData);
            };
            row.ondblclick = () => { selectedPath = entry.path; cleanup(); onSelect(selectedPath); };
            row.oncontextmenu = (e) => showContextMenu(e, entry.path, false, getBookmarks, addBookmark, removeBookmark, renderBookmarks);
            listContainer.appendChild(row);
        }
        
        // Render images as thumbnails with preview
        if (filteredImageFiles.length > 0) {
            console.log("[MetaPromptExtractor] Rendering", filteredImageFiles.length, "image thumbnails");
            const sortMethod = sortSelect.value;
            const sortedImageFiles = sortImages(filteredImageFiles, sortMethod);
            const colsPerRow = parseInt(sizeSlider.value);
            const imageGridContainer = document.createElement('div');
            imageGridContainer.style.cssText = `display:grid;grid-template-columns:repeat(${colsPerRow}, 1fr);gap:10px;padding:10px;`;
            
            for (const entry of sortedImageFiles) {
                const isSelected = entry.path === selectedPath;
                const imgWrapper = document.createElement('div');
                imgWrapper.style.cssText = `position:relative;aspect-ratio:1;border:2px solid ${isSelected?'#2a6ea6':'#3a4a5a'};border-radius:6px;overflow:hidden;cursor:pointer;background:#111820;flex-direction:column;display:flex;align-items:center;justify-content:center;`;
                
                const img = document.createElement('img');
                img.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain;';
                
                // Build preview URL
                let previewUrl = '';
                if (isAbsolutePath(entry.path)) {
                    previewUrl = `/meta-prompt-extractor/serve-file?path=${encodeURIComponent(entry.path)}`;
                } else {
                    const parts = entry.path.split('/');
                    const filename = parts[parts.length - 1];
                    const subfolder = parts.slice(0, -1).join('/');
                    previewUrl = `/view?filename=${encodeURIComponent(filename)}&type=input`;
                    if (subfolder) previewUrl += `&subfolder=${encodeURIComponent(subfolder)}`;
                }
                
                console.log("[MetaPromptExtractor] Loading image thumbnail:", entry.name, "URL:", previewUrl);
                
                img.src = previewUrl;
                img.onerror = () => {
                    console.warn("[MetaPromptExtractor] Failed to load thumbnail:", entry.name, "from", previewUrl);
                    imgWrapper.innerHTML = '<span style="font-size:40px;color:#7a9ab8;text-align:center;">📄</span>';
                };
                img.onload = () => {
                    console.log("[MetaPromptExtractor] Successfully loaded thumbnail:", entry.name);
                    // Extract and display image dimensions
                    const width = img.naturalWidth;
                    const height = img.naturalHeight;
                    // Store dimensions on entry for sorting purposes
                    entry.width = width;
                    entry.height = height;
                    if (width && height) {
                        const dimensionsLabel = document.createElement('div');
                        dimensionsLabel.style.cssText = 'position:absolute;top:0;left:0;right:0;background:rgba(0,0,0,0.7);color:#a8dff0;font-size:10px;padding:3px;text-align:center;font-weight:600;font-family:monospace;';
                        dimensionsLabel.textContent = `${width}×${height}`;
                        imgWrapper.appendChild(dimensionsLabel);
                    }
                };
                
                imgWrapper.appendChild(img);
                
                // Add filename label at bottom with metadata indicator
                const nameLabel = document.createElement('div');
                nameLabel.style.cssText = 'position:absolute;bottom:0;left:0;right:0;background:rgba(0,0,0,0.6);color:#c8dff0;font-size:10px;padding:3px 4px;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
                
                let labelText = entry.name;
                if (entry.has_metadata) {
                    labelText = '📋 ' + labelText;
                }
                
                nameLabel.textContent = labelText;
                nameLabel.title = entry.name;
                imgWrapper.appendChild(nameLabel);
                
                // Add file info overlay (size, date) - shown on hover
                const infoOverlay = document.createElement('div');
                infoOverlay.style.cssText = 'position:absolute;inset:0;background:rgba(0,0,0,0.8);color:#a8dff0;font-size:9px;padding:6px;opacity:0;display:flex;align-items:flex-end;justify-content:center;text-align:center;line-height:1.3;transition:opacity 0.2s;';
                
                let infoText = [];
                if (entry.size !== undefined) {
                    const sizeStr = entry.size < 1024 ? entry.size + 'B' :
                                   entry.size < 1024*1024 ? (entry.size/1024).toFixed(1) + 'KB' :
                                   (entry.size/(1024*1024)).toFixed(1) + 'MB';
                    infoText.push(sizeStr);
                }
                if (entry.mtime) {
                    const date = new Date(entry.mtime * 1000);
                    infoText.push(date.toLocaleDateString('en-US', {month: 'short', day: 'numeric'}));
                }
                infoOverlay.textContent = infoText.join(' • ');
                
                imgWrapper.appendChild(infoOverlay);
                
                imgWrapper.onmouseenter = () => { infoOverlay.style.opacity = '1'; };
                imgWrapper.onmouseleave = () => { infoOverlay.style.opacity = '0'; };
                
                imgWrapper.onclick = () => {
                    selectedPath = entry.path;
                    selectedLabel.textContent = `Selected: ${entry.path}`;
                    selectBtn.disabled = false; selectBtn.style.opacity = '1';
                    displayMetadata(entry.path);
                    renderDir(currentBrowseData);
                };
                imgWrapper.ondblclick = () => { selectedPath = entry.path; cleanup(); onSelect(selectedPath); };
                imgWrapper.oncontextmenu = (e) => showContextMenu(e, entry.path, false, getBookmarks, addBookmark, removeBookmark, renderBookmarks);
                
                imageGridContainer.appendChild(imgWrapper);
            }
            
            listContainer.appendChild(imageGridContainer);
        }
    };

    const navigate = async (path) => {
        setLoading();
        // Clear filter when navigating to a new directory
        searchInput.value = '';
        currentFilter = '';
        searchResultsLabel.textContent = '';
        cachedMetadata = {}; // Clear metadata cache
        try {
            const resp = await fetch(`/meta-prompt-extractor/browse?path=${encodeURIComponent(path)}`);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            if (data.error) throw new Error(data.error);
            currentPath = data.current;
            pathInput.value = currentPath;
            renderBreadcrumbs(currentPath);
            upBtn.disabled = !data.parent;
            upBtn._parentPath = data.parent;
            // Update star button appearance based on whether current folder is bookmarked
            const isBookmarked = getBookmarks().some(b => b.path === currentPath);
            starBtn.style.color = isBookmarked ? '#ffd700' : '#9ab8d0';
            starBtn.style.background = isBookmarked ? '#3a5a70' : '#253040';
            renderDir(data);
            renderBookmarks();
            // Remember last browsed directory
            try {
                localStorage.setItem('metaPromptExtractor_lastBrowsedPath', currentPath);
            } catch (e) {
                console.warn("[MetaPromptExtractor] Failed to save last browsed path:", e);
            }
        } catch (e) {
            listContainer.innerHTML = `<div style="color:#e07070;font-size:13px;padding:16px;">${e.message}</div>`;
        }
    };
    
    const renderBookmarks = () => {
        bookmarksList.innerHTML = '';
        const bookmarks = getBookmarks();
        
        if (bookmarks.length === 0) {
            const emptyMsg = document.createElement('div');
            emptyMsg.style.cssText = 'font-size:11px;color:#5a7a98;padding:10px 8px;text-align:center;';
            emptyMsg.textContent = 'No favorites yet';
            bookmarksList.appendChild(emptyMsg);
            return;
        }
        
        for (const bookmark of bookmarks) {
            const bookmarkItem = document.createElement('div');
            const isCurrentPath = bookmark.path === currentPath;
            bookmarkItem.style.cssText = `display:flex;align-items:center;gap:6px;padding:8px 8px;margin:2px 4px;cursor:pointer;user-select:none;background:${isCurrentPath?'rgba(42,110,166,0.35)':'transparent'};border-radius:4px;border-left:3px solid ${isCurrentPath?'#2a6ea6':'transparent'};transition:all 0.15s;`;
            bookmarkItem.onmouseenter = () => { if (!isCurrentPath) bookmarkItem.style.background = 'rgba(255,255,255,0.06)'; };
            bookmarkItem.onmouseleave = () => { if (!isCurrentPath) bookmarkItem.style.background = 'transparent'; };
            
            const nameSpan = document.createElement('span');
            nameSpan.textContent = bookmark.name;
            nameSpan.style.cssText = `flex:1;font-size:12px;color:${isCurrentPath?'#9bcce8':'#7a9ab8'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`;
            bookmarkItem.appendChild(nameSpan);
            
            const removeBtn = document.createElement('button');
            removeBtn.textContent = '✕';
            removeBtn.style.cssText = 'background:none;border:none;color:#7a5a5a;cursor:pointer;font-size:12px;padding:2px 4px;border-radius:3px;opacity:0;transition:opacity 0.15s;';
            removeBtn.onclick = (e) => {
                e.stopPropagation();
                removeBookmark(bookmark.path);
                renderBookmarks();
                console.log("[MetaPromptExtractor] Removed bookmark:", bookmark.name);
            };
            bookmarkItem.onmouseenter = () => {
                if (!isCurrentPath) bookmarkItem.style.background = 'rgba(255,255,255,0.06)';
                removeBtn.style.opacity = '1';
                removeBtn.style.color = '#e07070';
            };
            bookmarkItem.onmouseleave = () => {
                if (!isCurrentPath) bookmarkItem.style.background = 'transparent';
                removeBtn.style.opacity = '0';
                removeBtn.style.color = '#7a5a5a';
            };
            bookmarkItem.appendChild(removeBtn);
            
            bookmarkItem.onclick = () => navigate(bookmark.path);
            bookmarksList.appendChild(bookmarkItem);
        }
    };

    const showRoots = async () => {
        setLoading();
        try {
            const resp = await fetch('/meta-prompt-extractor/list-roots');
            const data = await resp.json();
            listContainer.innerHTML = ''; currentPath = null; pathInput.value = '';
            breadcrumbsContainer.innerHTML = '';
            const drivesTitle = document.createElement('div');
            drivesTitle.style.cssText = 'display:flex;align-items:center;gap:4px;padding:4px 8px;background:#253040;border-radius:4px;color:#9bcce8;font-size:12px;white-space:nowrap;';
            drivesTitle.textContent = '💾 Drives';
            breadcrumbsContainer.appendChild(drivesTitle);
            currentBrowseData = { entries: data.roots.map(r => ({ name:r, path:r, type:'dir' })) };
            starBtn.style.color = '#9ab8d0';
            starBtn.style.background = '#253040';
            renderBookmarks();
            for (const root of data.roots) {
                const row = document.createElement('div');
                row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 14px;cursor:pointer;user-select:none;';
                row.onmouseenter = () => row.style.background = 'rgba(255,255,255,0.04)';
                row.onmouseleave = () => row.style.background = '';
                const icon = document.createElement('span'); icon.textContent = '💾'; icon.style.cssText = 'font-size:15px;width:20px;text-align:center;';
                const label = document.createElement('span'); label.textContent = root; label.style.cssText = 'font-size:13px;color:#9bcce8;';
                row.appendChild(icon); row.appendChild(label);
                row.onclick = () => navigate(root);
                listContainer.appendChild(row);
            }
        } catch (e) {
            listContainer.innerHTML = `<div style="color:#e07070;font-size:13px;padding:16px;">Could not list drives: ${e.message}</div>`;
        }
    };

    upBtn.onclick   = () => { if (upBtn._parentPath) navigate(upBtn._parentPath); };
    homeBtn.onclick = async () => {
        try { const r = await (await fetch('/meta-prompt-extractor/browse')).json(); navigate(r.current); }
        catch { navigate('/'); }
    };
    rootBtn.onclick = () => showRoots();
    starBtn.onclick = () => {
        if (!currentPath) return;
        const isBookmarked = getBookmarks().some(b => b.path === currentPath);
        if (isBookmarked) {
            removeBookmark(currentPath);
            console.log("[MetaPromptExtractor] Removed from favorites:", currentPath);
        } else {
            addBookmark(currentPath);
            console.log("[MetaPromptExtractor] Added to favorites:", currentPath);
        }
        renderBookmarks();
        // Update star button appearance
        const stillBookmarked = getBookmarks().some(b => b.path === currentPath);
        starBtn.style.color = stillBookmarked ? '#ffd700' : '#9ab8d0';
        starBtn.style.background = stillBookmarked ? '#3a5a70' : '#253040';
    };
    sizeSlider.oninput = () => {
        // Re-render current directory with new grid size
        if (currentBrowseData) {
            renderDir(currentBrowseData);
        }
    };
    sortSelect.onchange = () => {
        // Re-render current directory with new sort method
        if (currentBrowseData) {
            renderDir(currentBrowseData);
        }
    };
    cancelBtn.onclick = () => cleanup();
    closeBtn.onclick  = () => cleanup();
    overlay.onclick   = (e) => { if (e.target === overlay) cleanup(); };
    selectBtn.onclick = () => { if (selectedPath) { cleanup(); onSelect(selectedPath); } };
    pathInput.onkeydown = (e) => { if (e.key === 'Enter' && pathInput.value.trim()) navigate(pathInput.value.trim()); };
    document.addEventListener('keydown', handleKey);
    function handleKey(e) { if (e.key === 'Escape') cleanup(); }
    const cleanup = () => {
        document.removeEventListener('keydown', handleKey);
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    };
    document.body.appendChild(overlay);

    // Initialize metadata panel
    clearMetadata();

    // Start navigation
    let startPath = null;
    
    // Try to restore last browsed directory
    try {
        const lastPath = localStorage.getItem('metaPromptExtractor_lastBrowsedPath');
        if (lastPath) {
            startPath = lastPath;
        }
    } catch (e) {
        console.warn("[MetaPromptExtractor] Failed to load last browsed path:", e);
    }
    
    if (!startPath && currentFile && isAbsolutePath(currentFile)) {
        const parts = currentFile.replace(/\\/g, '/').split('/');
        parts.pop();
        startPath = parts.join('/') || '/';
    }
    
    if (startPath) {
        renderBreadcrumbs(startPath);
        navigate(startPath);
    } else { 
        renderBreadcrumbs(null);
        homeBtn.click(); 
    }
}
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract metadata from PNG file
 * Reads tEXt/iTXt chunks for prompt and workflow (ComfyUI native approach)
 */
async function getPNGMetadata(file) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (event) => {
            const pngData = new Uint8Array(event.target.result);
            const dataView = new DataView(pngData.buffer);
            const decoder = new TextDecoder();

            // Verify PNG signature
            if (dataView.getUint32(0) !== 0x89504E47 || dataView.getUint32(4) !== 0x0D0A1A0A) {
                resolve(null);
                return;
            }

            let prompt = null;
            let workflow = null;
            let parameters = null; // A1111/Forge parameters that ComfyUI can convert to workflow
            let offset = 8; // Skip PNG signature

            // Parse PNG chunks
            while (offset < pngData.length - 12) {
                const chunkLength = dataView.getUint32(offset);
                const chunkType = String.fromCharCode(
                    pngData[offset + 4],
                    pngData[offset + 5],
                    pngData[offset + 6],
                    pngData[offset + 7]
                );

                // Check for tEXt or iTXt chunks
                if (chunkType === 'tEXt' || chunkType === 'iTXt') {
                    const chunkData = pngData.slice(offset + 8, offset + 8 + chunkLength);

                    // Find null terminator for keyword
                    let keywordEnd = 0;
                    while (keywordEnd < chunkData.length && chunkData[keywordEnd] !== 0) {
                        keywordEnd++;
                    }

                    const keyword = decoder.decode(chunkData.slice(0, keywordEnd));
                    let text = '';

                    if (chunkType === 'tEXt') {
                        text = decoder.decode(chunkData.slice(keywordEnd + 1));
                    } else if (chunkType === 'iTXt') {
                        // iTXt format: keyword\0compression\0language\0translated\0text
                        const compression = chunkData[keywordEnd + 1];
                        let textStart = keywordEnd + 2;
                        // Skip language and translated keyword (find two more nulls)
                        let nullCount = 0;
                        while (textStart < chunkData.length && nullCount < 2) {
                            if (chunkData[textStart] === 0) nullCount++;
                            textStart++;
                        }
                        text = decoder.decode(chunkData.slice(textStart));
                    }

                    // Check for ComfyUI metadata or A1111 parameters
                    if (keyword === 'prompt') {
                        try {
                            prompt = JSON.parse(text);
                        } catch (e) {
                            // JSON.parse rejects values like NaN that are valid JS but
                            // not valid JSON (e.g. ComfyUI encodes NaN in some nodes).
                            // Store the raw string so Python receives it and can process
                            // it exactly as PIL does — Python's _coerce_to_dict handles
                            // the raw string and its json.loads is more forgiving, or
                            // parse_workflow_for_prompts can work from raw string data.
                            console.warn('[MetaPromptExtractor] prompt chunk is not strict JSON, storing raw string for Python:', e.message);
                            prompt = text;
                        }
                    } else if (keyword === 'workflow') {
                        try {
                            workflow = JSON.parse(text);
                        } catch (e) {
                            // Same treatment as prompt — preserve raw string for Python.
                            console.warn('[MetaPromptExtractor] workflow chunk is not strict JSON, storing raw string for Python:', e.message);
                            workflow = text;
                        }
                    } else if (keyword === 'parameters') {
                        // A1111/Forge generation parameters (ComfyUI can load workflow from this)
                        parameters = text;
                    }
                }

                // Move to next chunk (length + type + data + CRC)
                offset += 12 + chunkLength;

                // Stop if we found metadata or reached IEND
                if ((prompt && workflow) || parameters || chunkType === 'IEND') {
                    break;
                }
            }

            // Return metadata if found (including A1111 parameters)
            if (prompt || workflow || parameters) {
                const metadata = { prompt, workflow, parameters };
                
                // If we have A1111 parameters, parse them for easier access
                if (parameters && !workflow) {
                    metadata.parsed_parameters = parseA1111Parameters(parameters);
                }
                
                resolve(metadata);
            } else {
                resolve(null);
            }
        };
        reader.readAsArrayBuffer(file);
    });
}

/**
 * Parse A1111/Forge parameters format
 * Extracts prompt and negative prompt (strips LoRA tags)
 */
function parseA1111Parameters(parametersText) {
    if (!parametersText) return null;

    const result = {
        prompt: '',
        negative_prompt: ''
    };

    // Split by "Negative prompt:" to separate positive and negative
    const parts = parametersText.split(/Negative prompt:\s*/i);
    let positivePrompt = parts[0].trim();
    let remainder = parts[1] || '';

    // Remove LoRA tags from prompt
    const loraRegex = /<lora:([^:>]+):([^:>]+)(?::([^:>]+))?>/gi;
    positivePrompt = positivePrompt.replace(loraRegex, '').trim();
    result.prompt = positivePrompt;

    // Extract negative prompt (before any "Steps:" line if present)
    const settingsMatch = remainder.match(/^(.*?)[\r\n]+Steps:/s);
    if (settingsMatch) {
        result.negative_prompt = settingsMatch[1].trim();
    } else {
        result.negative_prompt = remainder.trim();
    }

    return result;
}

/**
 * Extract metadata from JPEG/WebP file
 * Reads EXIF UserComment field (0x9286) for workflow metadata
 */
async function getJPEGMetadata(file) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (event) => {
            const imageData = new Uint8Array(event.target.result);
            const dataView = new DataView(imageData.buffer);
            const decoder = new TextDecoder();

            // Check for JPEG signature (0xFFD8)
            if (dataView.getUint16(0) !== 0xFFD8) {
                resolve(null);
                return;
            }

            // Search for APP1 marker (EXIF) - 0xFFE1
            let offset = 2;
            while (offset < imageData.length - 4) {
                const marker = dataView.getUint16(offset);
                const segmentLength = dataView.getUint16(offset + 2);

                if (marker === 0xFFE1) {
                    // Check for EXIF header
                    const exifHeader = String.fromCharCode(...imageData.slice(offset + 4, offset + 10));
                    if (exifHeader === 'Exif\x00\x00') {
                        // Parse TIFF header
                        const tiffOffset = offset + 10;
                        const byteOrder = dataView.getUint16(tiffOffset);
                        const littleEndian = byteOrder === 0x4949;

                        // Get IFD0 offset
                        const ifd0Offset = tiffOffset + dataView.getUint32(tiffOffset + 4, littleEndian);

                        // Search for UserComment tag (0x9286)
                        const metadata = parseIFD(imageData, ifd0Offset, tiffOffset, littleEndian, decoder);
                        if (metadata) {
                            resolve(metadata);
                            return;
                        }
                    }
                }

                // Move to next marker
                if (marker >= 0xFF00) {
                    offset += 2 + segmentLength;
                } else {
                    break;
                }
            }

            resolve(null);
        };
        reader.readAsArrayBuffer(file);
    });
}

/**
 * Parse EXIF IFD (Image File Directory) for ComfyUI metadata
 * ComfyUI stores metadata in:
 *   - 0x010e (ImageDescription): "Workflow: {json}" 
 *   - 0x010f (Make): "Prompt: {json}"
 *   - 0x9286 (UserComment): direct JSON (some tools)
 */
function parseIFD(imageData, ifdOffset, tiffOffset, littleEndian, decoder) {
    const dataView = new DataView(imageData.buffer);
    const numEntries = dataView.getUint16(ifdOffset, littleEndian);

    // Collect workflow and prompt from separate EXIF tags
    let workflow = null;
    let prompt = null;

    for (let i = 0; i < numEntries; i++) {
        const entryOffset = ifdOffset + 2 + (i * 12);
        const tag = dataView.getUint16(entryOffset, littleEndian);

        // Tags that store string data: 0x010e (ImageDescription), 0x010f (Make), 0x9286 (UserComment)
        if (tag === 0x010e || tag === 0x010f || tag === 0x9286) {
            const count = dataView.getUint32(entryOffset + 4, littleEndian);
            const valueOffset = dataView.getUint32(entryOffset + 8, littleEndian);

            // Get actual data offset (values > 4 bytes are stored at an offset)
            const dataOffset = count > 4 ? tiffOffset + valueOffset : entryOffset + 8;

            // Read the raw string data
            const rawData = imageData.slice(dataOffset, dataOffset + count);
            let text = decoder.decode(rawData);

            // Remove ASCII/UNICODE prefix and null bytes (for UserComment tag)
            text = text.replace(/^(ASCII|UNICODE)\x00*/, '').replace(/\x00/g, '').trim();

            // ComfyUI format: "Workflow: {json}" or "Prompt: {json}" with prefix
            if (text.startsWith('Workflow:')) {
                const jsonStr = text.substring('Workflow:'.length).trim();
                try { workflow = JSON.parse(jsonStr); } catch (e) {
                    console.error('[MetaPromptExtractor] Failed to parse Workflow from EXIF:', e);
                }
            } else if (text.startsWith('Prompt:')) {
                const jsonStr = text.substring('Prompt:'.length).trim();
                try { prompt = JSON.parse(jsonStr); } catch (e) {
                    console.error('[MetaPromptExtractor] Failed to parse Prompt from EXIF:', e);
                }
            } else {
                // Try parsing as direct JSON (UserComment from some tools)
                try {
                    const json = JSON.parse(text);
                    return json;
                } catch (e) {
                    // Not JSON, skip
                }
            }
        }

        // Check for EXIF SubIFD (tag 0x8769)
        if (tag === 0x8769) {
            const subIfdOffset = tiffOffset + dataView.getUint32(entryOffset + 8, littleEndian);
            const metadata = parseIFD(imageData, subIfdOffset, tiffOffset, littleEndian, decoder);
            if (metadata) return metadata;
        }
    }

    // Return collected workflow/prompt if found
    if (workflow || prompt) {
        return { workflow, prompt };
    }

    return null;
}

/**
 * Extract metadata from WebP file
 * WebP uses RIFF container format with EXIF data stored in an "EXIF" chunk
 */
async function getWebPMetadata(file) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (event) => {
            const data = new Uint8Array(event.target.result);
            const dataView = new DataView(data.buffer);
            const decoder = new TextDecoder();

            // Verify RIFF + WEBP signature
            if (data.length < 12) { resolve(null); return; }
            const riff = String.fromCharCode(data[0], data[1], data[2], data[3]);
            const webp = String.fromCharCode(data[8], data[9], data[10], data[11]);
            if (riff !== 'RIFF' || webp !== 'WEBP') {
                resolve(null);
                return;
            }

            // Walk RIFF chunks looking for EXIF chunk
            let offset = 12;
            while (offset < data.length - 8) {
                const chunkId = String.fromCharCode(data[offset], data[offset + 1], data[offset + 2], data[offset + 3]);
                const chunkSize = dataView.getUint32(offset + 4, true); // RIFF uses little-endian

                if (chunkId === 'EXIF') {
                    // EXIF chunk data starts after the chunk header (8 bytes)
                    let exifStart = offset + 8;

                    // Some WebP files include "Exif\0\0" prefix before TIFF header, some don't
                    const possibleExif = String.fromCharCode(data[exifStart], data[exifStart + 1], data[exifStart + 2], data[exifStart + 3]);
                    if (possibleExif === 'Exif') {
                        exifStart += 6; // Skip "Exif\0\0"
                    }

                    // Parse TIFF header
                    if (exifStart + 8 <= data.length) {
                        const byteOrder = dataView.getUint16(exifStart);
                        const littleEndian = byteOrder === 0x4949;

                        // Verify TIFF magic number (42)
                        const tiffMagic = dataView.getUint16(exifStart + 2, littleEndian);
                        if (tiffMagic === 42) {
                            const ifd0Offset = exifStart + dataView.getUint32(exifStart + 4, littleEndian);
                            const metadata = parseIFD(data, ifd0Offset, exifStart, littleEndian, decoder);
                            if (metadata) {
                                resolve(metadata);
                                return;
                            }
                        }
                    }
                }

                // Move to next chunk (pad to even size per RIFF spec)
                offset += 8 + chunkSize + (chunkSize % 2);
            }

            resolve(null);
        };
        reader.readAsArrayBuffer(file);
    });
}

/**
 * Send file metadata to Python backend for caching
 */
async function cacheFileMetadata(filename, metadata) {
    try {
        const response = await api.fetchApi("/meta-prompt-extractor/cache-file-metadata", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ filename, metadata })
        });

        if (response.ok) {
            console.log(`[MetaPromptExtractor] Cached metadata for: ${filename}`);
        } else {
            console.error("[MetaPromptExtractor] Failed to cache metadata:", response.status);
        }
    } catch (error) {
        console.error("[MetaPromptExtractor] Error caching metadata:", error);
    }
}

/**
 * Create and show image preview modal
 */
function showImagePreviewModal(filename, viewType) {
    // Build image URL
    let actualFilename = filename;
    let subfolder = "";
    
    if (filename.includes('/')) {
        const lastSlash = filename.lastIndexOf('/');
        subfolder = filename.substring(0, lastSlash);
        actualFilename = filename.substring(lastSlash + 1);
    }
    
    let imageUrl = `/view?filename=${encodeURIComponent(actualFilename)}&type=${viewType || 'input'}`;
    if (subfolder) {
        imageUrl += `&subfolder=${encodeURIComponent(subfolder)}`;
    }

    // Create modal overlay
    const overlay = document.createElement('div');
    overlay.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0, 0, 0, 0.85);
        z-index: 10000;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
    `;

    // Create header with filename and close button
    const header = document.createElement('div');
    header.style.cssText = `
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        padding: 15px 20px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        background: rgba(0, 0, 0, 0.5);
    `;

    const title = document.createElement('span');
    title.textContent = filename;
    title.style.cssText = `
        color: #fff;
        font-size: 14px;
        font-family: sans-serif;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        max-width: calc(100% - 50px);
    `;

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '?';
    closeBtn.style.cssText = `
        background: rgba(255, 255, 255, 0.1);
        border: none;
        color: #fff;
        font-size: 20px;
        width: 36px;
        height: 36px;
        border-radius: 50%;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: background 0.2s;
    `;
    closeBtn.onmouseover = () => closeBtn.style.background = 'rgba(255, 255, 255, 0.2)';
    closeBtn.onmouseout = () => closeBtn.style.background = 'rgba(255, 255, 255, 0.1)';
    closeBtn.onclick = () => overlay.remove();

    header.appendChild(title);
    header.appendChild(closeBtn);

    // Create image container
    const imageContainer = document.createElement('div');
    imageContainer.style.cssText = `
        max-width: 90%;
        max-height: 80%;
        display: flex;
        align-items: center;
        justify-content: center;
    `;

    // Create image element
    const img = document.createElement('img');
    img.src = imageUrl;
    img.style.cssText = `
        max-width: 100%;
        max-height: 80vh;
        border-radius: 8px;
        box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
    `;

    // Error handling
    img.onerror = () => {
        imageContainer.innerHTML = `
            <div style="color: #ff6666; font-family: sans-serif; text-align: center;">
                <div style="font-size: 48px; margin-bottom: 10px;">??</div>
                <div>Failed to load image</div>
                <div style="font-size: 12px; margin-top: 5px; opacity: 0.7;">${filename}</div>
            </div>
        `;
    };

    imageContainer.appendChild(img);

    // Create keyboard hint
    const hint = document.createElement('div');
    hint.textContent = 'Press ESC or click outside to close';
    hint.style.cssText = `
        position: absolute;
        bottom: 20px;
        color: rgba(255, 255, 255, 0.5);
        font-size: 12px;
        font-family: sans-serif;
    `;

    overlay.appendChild(header);
    overlay.appendChild(imageContainer);
    overlay.appendChild(hint);

    // Close on overlay click (but not image click)
    overlay.onclick = (e) => {
        if (e.target === overlay) {
            overlay.remove();
        }
    };

    // Close on ESC key
    const handleKeydown = (e) => {
        if (e.key === 'Escape') {
            overlay.remove();
            document.removeEventListener('keydown', handleKeydown);
        }
    };
    document.addEventListener('keydown', handleKeydown);

    // Add to document
    document.body.appendChild(overlay);
}

/**
 * Check if filename is a previewable file (image only)
 */
function isPreviewableFile(filename) {
    if (!filename || filename === '(none)') return false;
    const ext = filename.split('.').pop().toLowerCase();
    const imageExtensions = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'];
    return imageExtensions.includes(ext);
}

console.log("[MetaPromptExtractor] Extension starting registration...");

app.registerExtension({
    name: "MetaPromptExtractor",

    async setup() {
        console.log("[MetaPromptExtractor] setup() called");
    },

    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        console.log("[MetaPromptExtractor] beforeRegisterNodeDef called for:", nodeData?.name);
        if (nodeData.name !== "MetaPromptExtractor") return;
        
        console.log("[MetaPromptExtractor] Processing MetaPromptExtractor node...");
        // ComfyUI suppresses widgets and converts them to input slots based on heuristics.
        // We need to explicitly prevent this by modifying nodeData.
        
        // Store original widgets override if it exists
        const origWidgetOverride = nodeData.widgets_override || [];
        nodeData.widgets_override = [
            ...origWidgetOverride,
            {
                // Force "image" to be a widget dropdown/combobox, not a connection input
                widget: "combo",
                name: "image",
                options: ["(none)", ""],
            }
        ];

        console.log("[MetaPromptExtractor] Applied widgets_override:", nodeData.widgets_override);

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = onNodeCreated?.apply(this, arguments);
            const node = this;

            node.hasWorkflow          = false;
            node._loadedImageFilename = null;
            node._loadedFramePosition = null;
            node._metadataCached      = false;

            // ── Debug: Log all widgets ──
            console.log("[MetaPromptExtractor] onNodeCreated - widgets:", node.widgets?.map(w => ({ name: w.name, type: w.type, value: w.value })) || "NO WIDGETS");
            console.log("[MetaPromptExtractor] Node inputs:", node.inputs?.map(i => ({ name: i.name, type: i.type })) || "NO INPUTS");

            // ── Find widgets synchronously — they exist at onNodeCreated time
            //    because "image" is now a COMBO widget (list), not STRING ──
            let imageWidget = node.widgets?.find(w => w.name === "image");

            if (!imageWidget) {
                console.warn("[MetaPromptExtractor] image widget not found — creating manually");
                const comboWidget = {
                    name: "image",
                    type: "combo",
                    value: "(none)",
                    options: ["(none)", ""],
                    callback: () => {},
                    serialize: true,
                    draw: function(ctx, size, pos) { /* handled by LiteGraph */ },
                    computeSize: function() { return [300, 20]; },
                };
                
                if (!node.widgets) node.widgets = [];
                node.widgets.push(comboWidget);
                imageWidget = comboWidget;
                console.log("[MetaPromptExtractor] Manually created image widget");
            } else {
                console.log("[MetaPromptExtractor] image widget found:", { name: imageWidget.name, type: imageWidget.type, value: imageWidget.value });
            }

            // ── Wire image widget callback ──
            const origImageCb = imageWidget.callback;
            imageWidget.callback = function(value) {
                if (origImageCb) origImageCb.apply(this, arguments);
                node._metadataCached = false;
                loadAndDisplayImage(node, value);
            };

            // ── Splice in Browse button right after image widget (same as original) ──
            const imageWidgetIndex = node.widgets.indexOf(imageWidget);
            const browseButtonHandler = async () => {
                console.log("[MetaPromptExtractor] Browse button clicked!");
                // Derive starting directory from current value
                let initialDir = "";
                const cur = imageWidget.value || "";
                if (cur && isAbsolutePath(cur)) {
                    const parts = cur.replace(/\\/g, "/").split("/");
                    parts.pop();
                    initialDir = parts.join("/");
                }

                browseButton.name = "\u23F3 Opening\u2026";
                node.setDirtyCanvas(true);

                try {
                    const qs   = initialDir ? `?initial_dir=${encodeURIComponent(initialDir)}` : "";
                    console.log("[MetaPromptExtractor] Fetching file dialog from:", `/meta-prompt-extractor/open-file-dialog${qs}`);
                    const resp = await api.fetchApi(`/meta-prompt-extractor/open-file-dialog${qs}`);
                    if (resp.ok) {
                        const data = await resp.json();
                        console.log("[MetaPromptExtractor] File dialog returned:", data);
                        if (!data.cancelled && data.path) {
                            console.log("[MetaPromptExtractor] File selected via native dialog:", data.path);
                            imageWidget.value = data.path;
                            if (imageWidget.callback) imageWidget.callback(data.path);
                            browseButton.name = "\uD83D\uDCC1 Browse Files";
                            node.setDirtyCanvas(true);
                            return;
                        } else {
                            console.log("[MetaPromptExtractor] Native dialog cancelled, falling back to browser modal");
                        }
                    } else {
                        console.warn("[MetaPromptExtractor] Native dialog request failed, trying browser modal");
                    }
                } catch (err) {
                    console.warn("[MetaPromptExtractor] Native dialog error, using browser UI:", err);
                }

                // Fallback: in-browser filesystem tree
                console.log("[MetaPromptExtractor] Using fallback browser modal");
                browseButton.name = "\uD83D\uDCC1 Browse Files";
                node.setDirtyCanvas(true);
                createFileBrowserModal(imageWidget.value || null, (selectedFile) => {
                    console.log("[MetaPromptExtractor] Modal returned file:", selectedFile);
                    imageWidget.value = selectedFile;
                    if (imageWidget.callback) imageWidget.callback(selectedFile);
                    node.setDirtyCanvas(true);
                });
            };
            
            const browseButton = {
                type:      "button",
                name:      "\uD83D\uDCC1 Browse Files",
                value:     null,
                serialize: false,
                callback:  browseButtonHandler
            };
            node.widgets.splice(imageWidgetIndex + 1, 0, browseButton);

            // ── onConfigure: restore preview when workflow is loaded ──
            const origConfigure = node.onConfigure;
            node.onConfigure = function(info) {
                console.log("[MetaPromptExtractor] onConfigure called, inputs:", this.inputs?.map(i => i.name) || []);
                const r = origConfigure ? origConfigure.apply(this, arguments) : undefined;

                // ── CRITICAL: Convert inputs to widgets before removing them ──
                // If ComfyUI created "image" as an input slot instead of a widget, convert it here
                if (this.inputs && this.inputs.length > 0) {
                    const imageInput = this.inputs.find(inp => inp.name === "image");
                    if (imageInput && !node.widgets?.find(w => w.name === "image")) {
                        console.warn("[MetaPromptExtractor] Found 'image' input slot, converting to widget");
                        // Create widget from the input
                        const comboWidget = {
                            name: "image",
                            type: "combo",
                            value: "(none)",
                            options: ["(none)", ""],
                            callback: () => {},
                            serialize: true,
                        };
                        if (!this.widgets) this.widgets = [];
                        this.widgets.push(comboWidget);
                        // Re-assign imageWidget
                        const newImageWidget = this.widgets.find(w => w.name === "image");
                        if (newImageWidget) {
                            // Wire up the callback
                            const origImageCb = newImageWidget.callback;
                            newImageWidget.callback = function(value) {
                                if (origImageCb) origImageCb.apply(this, arguments);
                                node._metadataCached = false;
                                loadAndDisplayImage(node, value);
                            };
                            console.log("[MetaPromptExtractor] Converted input to widget successfully");
                        }
                    }
                }

                // Fix output shape (migration from old versions with lora/recipe outputs)
                const VALID_OUTPUTS = [
                    { name: "positive_prompt", type: "STRING" },
                    { name: "negative_prompt", type: "STRING" },
                    { name: "image",           type: "IMAGE"  },
                ];
                if (this.outputs) {
                    const ok = this.outputs.length === VALID_OUTPUTS.length &&
                        VALID_OUTPUTS.every((v, i) => this.outputs[i]?.name === v.name);
                    if (!ok) {
                        const savedLinks = this.outputs.map(o => o.links ? [...o.links] : null);
                        this.outputs.length = 0;
                        VALID_OUTPUTS.forEach((v, i) => {
                            this.addOutput(v.name, v.type);
                            if (savedLinks[i]) this.outputs[i].links = savedLinks[i];
                        });
                    }
                }
                
                // Now safe to remove inputs since we've converted them to widgets
                if (this.inputs) {
                    console.log("[MetaPromptExtractor] Removing inputs, count:", this.inputs.length);
                    for (let i = this.inputs.length - 1; i >= 0; i--) this.removeInput(i);
                }

                // ── Ensure Browse button exists ──
                const imageWidget = this.widgets?.find(w => w.name === "image");
                const browseButtonExists = this.widgets?.find(w => w.name?.includes("Browse"));
                if (imageWidget && !browseButtonExists) {
                    console.log("[MetaPromptExtractor] Adding Browse button in onConfigure");
                    const imageWidgetIndex = this.widgets.indexOf(imageWidget);
                    const configBrowseHandler = async () => {
                        console.log("[MetaPromptExtractor] onConfigure Browse button clicked!");
                        let initialDir = "";
                        const cur = imageWidget.value || "";
                        if (cur && isAbsolutePath(cur)) {
                            const parts = cur.replace(/\\/g, "/").split("/");
                            parts.pop();
                            initialDir = parts.join("/");
                        }
                        browseButton.name = "\u23F3 Opening\u2026";
                        node.setDirtyCanvas(true);
                        try {
                            const qs   = initialDir ? `?initial_dir=${encodeURIComponent(initialDir)}` : "";
                            console.log("[MetaPromptExtractor] onConfigure: Fetching file dialog from:", `/meta-prompt-extractor/open-file-dialog${qs}`);
                            const resp = await api.fetchApi(`/meta-prompt-extractor/open-file-dialog${qs}`);
                            if (resp.ok) {
                                const data = await resp.json();
                                console.log("[MetaPromptExtractor] onConfigure: File dialog returned:", data);
                                if (!data.cancelled && data.path) {
                                    console.log("[MetaPromptExtractor] onConfigure: File selected via native dialog:", data.path);
                                    imageWidget.value = data.path;
                                    if (imageWidget.callback) imageWidget.callback(data.path);
                                    browseButton.name = "\uD83D\uDCC1 Browse Files";
                                    node.setDirtyCanvas(true);
                                    return;
                                } else {
                                    console.log("[MetaPromptExtractor] onConfigure: Native dialog cancelled, falling back to browser modal");
                                }
                            } else {
                                console.warn("[MetaPromptExtractor] onConfigure: Native dialog request failed, trying browser modal");
                            }
                        } catch (err) {
                            console.warn("[MetaPromptExtractor] onConfigure: Native dialog error, using browser UI:", err);
                        }
                        browseButton.name = "\uD83D\uDCC1 Browse Files";
                        node.setDirtyCanvas(true);
                        console.log("[MetaPromptExtractor] onConfigure: Using fallback browser modal");
                        createFileBrowserModal(imageWidget.value || null, (selectedFile) => {
                            console.log("[MetaPromptExtractor] onConfigure: Modal returned file:", selectedFile);
                            imageWidget.value = selectedFile;
                            if (imageWidget.callback) imageWidget.callback(selectedFile);
                            node.setDirtyCanvas(true);
                        });
                    };
                    const browseButton = {
                        type:      "button",
                        name:      "\uD83D\uDCC1 Browse Files",
                        value:     null,
                        serialize: false,
                        callback:  configBrowseHandler
                    };
                    this.widgets.splice(imageWidgetIndex + 1, 0, browseButton);
                }

                // Restore preview
                setTimeout(() => {
                    const fp = imageWidget.value || "";
                    if (fp && fp !== "(none)" && fp !== "") {
                        loadAndDisplayImage(node, fp);
                    } else {
                        showPlaceholder(node);
                    }
                }, 100);

                return r;
            };

            // ── Initial load ──
            setTimeout(() => {
                const fp = imageWidget.value || "";
                if (fp && fp !== "(none)" && fp !== "") {
                    loadAndDisplayImage(node, fp);
                } else {
                    showPlaceholder(node);
                }
            }, 50);

            // ── Drag-and-drop ──
            node.onDragOver = (e) => {
                if (e.dataTransfer?.items) { e.preventDefault(); return true; }
                return false;
            };
            node.onDragDrop = async (e) => {
                e.preventDefault();
                const file = e.dataTransfer?.files?.[0];
                if (!file) return false;
                const ext = file.name.split(".").pop().toLowerCase();
                if (!["png","jpg","jpeg","webp"].includes(ext)) return false;

                // ── Step 1: Extract metadata from the original file bytes BEFORE
                //    any re-encoding happens. This is the only reliable read because
                //    ComfyUI's /view endpoint strips PNG text chunks when serving. ──
                let metadata = null;
                try {
                    if (ext === "png")                     metadata = await getPNGMetadata(file);
                    else if (["jpg","jpeg"].includes(ext)) metadata = await getJPEGMetadata(file);
                    else if (ext === "webp")               metadata = await getWebPMetadata(file);
                } catch (_) {}

                // ── Step 2: Upload the file to ComfyUI's input directory.
                //    This is mandatory: Python's extract() calls os.path.isfile() and
                //    returns empty strings immediately if the file doesn't exist on disk,
                //    before ever consulting the metadata cache. ──
                let resolvedFilename = file.name; // fallback if upload fails
                try {
                    const formData = new FormData();
                    formData.append("image", file, file.name);
                    formData.append("overwrite", "true");
                    const uploadResp = await api.fetchApi("/upload/image", {
                        method: "POST",
                        body: formData,
                    });
                    if (uploadResp.ok) {
                        const uploadData = await uploadResp.json();
                        // ComfyUI returns { name, subfolder, type }.
                        // Reconstruct the relative path Python will compute via
                        // os.path.relpath(resolved, input_dir): e.g. "image.png"
                        // or "subfolder/image.png".
                        const sub = uploadData.subfolder ? uploadData.subfolder + "/" : "";
                        resolvedFilename = sub + uploadData.name;
                    } else {
                        console.warn("[MetaPromptExtractor] Upload failed, Python will not find file on disk");
                    }
                } catch (uploadErr) {
                    console.warn("[MetaPromptExtractor] Upload error:", uploadErr);
                }

                // ── Step 3: Cache the JS-extracted metadata under the resolved filename.
                //    Python's extract_metadata_from_png/jpeg checks this cache first,
                //    keyed by os.path.relpath(file_path, input_dir) — which equals
                //    resolvedFilename for files in the input directory. ──
                await cacheFileMetadata(resolvedFilename, metadata);

                // ── Step 4: Update widget and node state. ──
                imageWidget.value   = resolvedFilename;
                node._metadataCached = true;
                node.hasWorkflow    = !!(metadata?.workflow || metadata?.parameters);

                // ── Step 5: Display image from the original blob (NOT via /view).
                //    We deliberately avoid calling loadImageFile() here because it
                //    re-fetches via /view which strips PNG metadata, causing it to
                //    call cacheFileMetadata(resolvedFilename, null) — which would
                //    leave no cache entry and force Python to fall back to PIL.
                //    PIL CAN read the file on disk, but only if /view hasn't also
                //    stripped the on-disk copy (which it hasn't — /view serves from
                //    the original bytes). So either path works, but using the blob
                //    is faster and avoids the extra round-trip. ──
                const blobUrl = URL.createObjectURL(file);
                const img = new Image();
                img.onload = () => {
                    node.imgs = [img];
                    node.imageIndex = 0;
                    node._loadedImageFilename = resolvedFilename;
                    const w = Math.max(node.size[0], 256);
                    node.setSize([w, Math.max(node.size[1], img.naturalHeight * (w / img.naturalWidth) + 100)]);
                    node.setDirtyCanvas(true, true);
                };
                img.src = blobUrl;
                node.setDirtyCanvas(true);
                return true;
            };

            return result;
        };
    }
});

/**
 * Extract metadata and update workflow indicator (without affecting display)
 */
async function extractAndUpdateMetadata(node, filename) {
    if (!filename || filename === "(none)") {
        node.hasWorkflow = false;
        node.setDirtyCanvas(true, true);
        return;
    }

    try {
        const ext = filename.split('.').pop().toLowerCase();
        const viewType = node._sourceFolder || 'input';
        
        const fileUrl = buildFileUrl(filename, viewType);
        if (!fileUrl) {
            node.hasWorkflow = false;
            node.setDirtyCanvas(true, true);
            return;
        }
        const response = await fetch(fileUrl);
        if (!response.ok) {
            console.warn(`[MetaPromptExtractor] Failed to fetch file for metadata: ${filename}`);
            node.hasWorkflow = false;
            node.setDirtyCanvas(true, true);
            return;
        }
        
        const fileBlob = await response.blob();
        let metadata = null;

        if (ext === 'png') {
            metadata = await getPNGMetadata(fileBlob);
        } else if (ext === 'webp') {
            metadata = await getWebPMetadata(fileBlob);
        } else if (['jpg', 'jpeg'].includes(ext)) {
            metadata = await getJPEGMetadata(fileBlob);
        }

        if (metadata !== null) {
            await cacheFileMetadata(filename, metadata);
        }

        node.hasWorkflow = !!(metadata && (metadata.workflow || metadata.parameters));
        node.setDirtyCanvas(true, true);
        app.graph.setDirtyCanvas(true, true);
    } catch (error) {
        console.error("[MetaPromptExtractor] Error extracting metadata:", error);
        node.hasWorkflow = false;
        node.setDirtyCanvas(true, true);
    }
}

/**
 * Load and display an image in the node
 */
async function loadAndDisplayImage(node, filename) {
    if (!filename) {
        showPlaceholder(node);
        return;
    }

    const ext = filename.split('.').pop().toLowerCase();
    const imageExtensions = ['png', 'jpg', 'jpeg', 'webp'];

    if (!imageExtensions.includes(ext)) {
        showPlaceholder(node);
        return;
    }

    loadImageFile(node, filename);
}

/**
 * Load an image file, display it, and extract metadata
 */
async function loadImageFile(node, filename) {
    try {
        const viewType = node._sourceFolder || 'input';
        const fileUrl = buildFileUrl(filename, viewType);
        if (!fileUrl) { showPlaceholder(node); return; }
        const imageBlob = await fetch(fileUrl).then(res => res.blob());

        // Extract metadata from image file (PNG or JPEG/WebP)
        const ext = filename.split('.').pop().toLowerCase();
        let metadata = null;

        if (ext === 'png') {
            metadata = await getPNGMetadata(imageBlob);
        } else if (ext === 'webp') {
            metadata = await getWebPMetadata(imageBlob);
        } else if (['jpg', 'jpeg'].includes(ext)) {
            metadata = await getJPEGMetadata(imageBlob);
        }

        // Cache metadata (or lack thereof) for Python backend
        await cacheFileMetadata(filename, metadata);

        // Update recipe status flag - check for workflow or parameters
        node.hasWorkflow = !!(metadata && (metadata.workflow || metadata.parameters));
        
        // Force canvas redraw to update indicator immediately
        node.setDirtyCanvas(true, true);
        app.graph.setDirtyCanvas(true, true);

        // Load and display the image
        const img = new Image();
        img.onload = () => {
            node.imgs = [img];
            node.imageIndex = 0;
            // Track that this image is now loaded
            node._loadedImageFilename = filename;

            // Resize node to fit image (like Load Image does)
            const targetWidth = Math.max(node.size[0], 256);
            const targetHeight = Math.max(node.size[1], img.naturalHeight * (targetWidth / img.naturalWidth) + 100);
            node.setSize([targetWidth, targetHeight]);

            node.setDirtyCanvas(true, true);
            app.graph.setDirtyCanvas(true, true);
        };

        img.onerror = () => {
            console.error(`[MetaPromptExtractor] Failed to load image: ${filename}`);
            showPlaceholder(node);
        };

        // Load from input/output directory
        img.src = fileUrl + (fileUrl.includes('?') ? '&' : '?') + 't=' + Date.now();
    } catch (error) {
        console.error("[MetaPromptExtractor] Error loading image:", error);
        showPlaceholder(node);
    }
}

/**
 * Show placeholder image for non-image files
 */
function showPlaceholder(node) {
    node._loadedImageFilename = null;
    node._loadedFramePosition = null;
    node._metadataCached = false;

    // Draw a dark gray placeholder canvas instead of loading an external PNG
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 192;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#1a2030';
    ctx.fillRect(0, 0, 256, 192);
    ctx.fillStyle = '#3a4a5a';
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('📁 Use Browse to load a file', 128, 96);

    const placeholderImg = new Image();
    placeholderImg.onload = () => {
        node.imgs = [placeholderImg];
        node.imageIndex = 0;
        node.setDirtyCanvas(true, true);
        app.graph.setDirtyCanvas(true, true);
    };
    placeholderImg.src = canvas.toDataURL('image/png');
}

console.log("[MetaPromptExtractor] Extension loaded");
