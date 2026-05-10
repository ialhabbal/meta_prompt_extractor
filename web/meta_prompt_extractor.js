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
// Folder Picker Dialog — used by Copy/Move context menu items instead of prompt()
// Returns a Promise<string|null> that resolves with the chosen folder path or
// null if the user cancelled.
// ─────────────────────────────────────────────────────────────────────────────

function _openFolderPickerDialog(title = 'Select a folder') {
    return new Promise((resolve) => {

        // ── Inject scoped styles once ──────────────────────────────────────────
        if (!document.getElementById('_mpe_fpd_style')) {
            const s = document.createElement('style');
            s.id = '_mpe_fpd_style';
            s.textContent = `
                .mpe-fpd-row {
                    display:flex;align-items:center;gap:7px;padding:5px 10px;
                    cursor:pointer;user-select:none;border-radius:4px;
                    font-family:sans-serif;font-size:13px;color:#c8dff0;
                    white-space:nowrap;overflow:hidden;
                }
                .mpe-fpd-row:hover  { background:rgba(255,255,255,0.06); }
                .mpe-fpd-row.active { background:rgba(42,110,166,0.40);color:#e8f4ff; }
                .mpe-fpd-arrow {
                    display:inline-block;width:14px;text-align:center;
                    font-size:11px;color:#7a9ab8;flex-shrink:0;transition:transform 0.12s;
                }
                .mpe-fpd-arrow.open { transform:rotate(90deg); }
                .mpe-fpd-icon  { font-size:15px;flex-shrink:0; }
                .mpe-fpd-label { flex:1;overflow:hidden;text-overflow:ellipsis; }
                .mpe-fpd-children { padding-left:18px; }
                .mpe-fpd-divider {
                    height:1px;background:#2e3d4e;margin:5px 8px;
                }
                .mpe-fpd-section-hdr {
                    font-size:10px;font-weight:700;color:#5a7a98;text-transform:uppercase;
                    padding:8px 10px 3px;letter-spacing:0.06em;font-family:sans-serif;
                }
                .mpe-fpd-crumb {
                    display:inline-flex;align-items:center;padding:3px 8px;border-radius:4px;
                    font-size:12px;cursor:pointer;color:#9bcce8;white-space:nowrap;
                    transition:background 0.12s;
                }
                .mpe-fpd-crumb:hover     { background:rgba(255,255,255,0.08); }
                .mpe-fpd-crumb.last      { color:#c8dff0;cursor:default;background:rgba(42,110,166,0.22); }
                .mpe-fpd-crumb-sep       { color:#5a7a98;font-size:14px;padding:0 1px; }
                .mpe-fpd-navbtn {
                    background:#253040;border:1px solid #3a4a5a;border-radius:5px;
                    color:#9ab8d0;padding:4px 9px;font-size:13px;cursor:pointer;
                    transition:background 0.12s;flex-shrink:0;
                }
                .mpe-fpd-navbtn:hover    { background:#2e3d4e; }
                .mpe-fpd-navbtn:disabled { opacity:0.35;cursor:default; }
                .mpe-fpd-main-row {
                    display:flex;align-items:center;gap:7px;padding:5px 12px;
                    cursor:pointer;user-select:none;font-family:sans-serif;
                    font-size:13px;color:#c8dff0;border-radius:4px;margin:1px 4px;
                }
                .mpe-fpd-main-row:hover  { background:rgba(255,255,255,0.05); }
                .mpe-fpd-main-row.active { background:rgba(42,110,166,0.38);color:#e8f4ff; }
            `;
            document.head.appendChild(s);
        }

        // ── Overlay + modal ────────────────────────────────────────────────────
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.72);z-index:10100;display:flex;align-items:center;justify-content:center;';

        const modal = document.createElement('div');
        modal.style.cssText = [
            'background:#1e2530;border:1px solid #3a4a5a;border-radius:10px;',
            'display:flex;flex-direction:column;',
            'box-shadow:0 16px 56px rgba(0,0,0,0.8);font-family:sans-serif;',
            'overflow:hidden;z-index:10101;',
            'width:760px;max-width:96vw;height:520px;max-height:92vh;',
            'box-sizing:border-box;position:relative;'
        ].join('');
        overlay.appendChild(modal);

        // ── Title bar ──────────────────────────────────────────────────────────
        const titleBar = document.createElement('div');
        titleBar.style.cssText = 'display:flex;align-items:center;gap:8px;padding:9px 14px;background:#161d27;border-bottom:1px solid #2e3d4e;flex-shrink:0;';
        const titleSpan = document.createElement('span');
        titleSpan.textContent = '📂 ' + title;
        titleSpan.style.cssText = 'color:#d0e4f4;font-size:14px;font-weight:700;flex:1;';
        const closeBtn = document.createElement('button');
        closeBtn.textContent = '✕';
        closeBtn.style.cssText = 'background:none;border:none;color:#8aaccc;font-size:16px;cursor:pointer;padding:2px 6px;border-radius:4px;line-height:1;';
        closeBtn.onclick = () => done(null);
        titleBar.appendChild(titleSpan);
        titleBar.appendChild(closeBtn);
        modal.appendChild(titleBar);

        // ── Toolbar: back / forward / up / breadcrumbs / path input ───────────
        const toolbar = document.createElement('div');
        toolbar.style.cssText = 'display:flex;align-items:center;gap:5px;padding:6px 10px;background:#1a2232;border-bottom:1px solid #2e3d4e;flex-shrink:0;';

        const mkNavBtn = (label, tip) => {
            const b = document.createElement('button');
            b.className = 'mpe-fpd-navbtn';
            b.textContent = label;
            b.title = tip;
            b.disabled = true;
            return b;
        };
        const backBtn    = mkNavBtn('◀', 'Back');
        const fwdBtn     = mkNavBtn('▶', 'Forward');
        const upBtn      = mkNavBtn('⬆', 'Up one level');
        const drivesBtn  = mkNavBtn('💾', 'Browse drives / root');

        // Breadcrumb strip (hides when path-input is focused)
        const breadcrumbWrap = document.createElement('div');
        breadcrumbWrap.style.cssText = 'flex:1;display:flex;align-items:center;gap:1px;overflow:hidden;background:#111820;border:1px solid #3a4a5a;border-radius:5px;padding:2px 6px;min-width:0;cursor:text;height:28px;box-sizing:border-box;';

        const pathInput = document.createElement('input');
        pathInput.type = 'text';
        pathInput.placeholder = 'Type a path and press Enter…';
        pathInput.style.cssText = 'flex:1;background:#111820;border:1px solid #3a4a5a;border-radius:5px;color:#c8dff0;padding:4px 9px;font-size:12px;outline:none;height:28px;box-sizing:border-box;display:none;';

        toolbar.appendChild(backBtn);
        toolbar.appendChild(fwdBtn);
        toolbar.appendChild(upBtn);
        toolbar.appendChild(drivesBtn);
        toolbar.appendChild(breadcrumbWrap);
        toolbar.appendChild(pathInput);
        modal.appendChild(toolbar);

        // Click on breadcrumb strip → switch to editable input
        breadcrumbWrap.addEventListener('click', () => {
            breadcrumbWrap.style.display = 'none';
            pathInput.style.display = '';
            pathInput.value = currentPath || '';
            pathInput.focus();
            pathInput.select();
        });
        pathInput.addEventListener('blur', () => {
            pathInput.style.display = 'none';
            breadcrumbWrap.style.display = '';
        });
        pathInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                const v = pathInput.value.trim();
                if (v) navigateTo(v);
                pathInput.blur();
            } else if (e.key === 'Escape') {
                pathInput.blur();
            }
        });

        // ── Body: left sidebar + right folder list ─────────────────────────────
        const body = document.createElement('div');
        body.style.cssText = 'display:flex;flex:1;min-height:0;';
        modal.appendChild(body);

        // ── Left sidebar ───────────────────────────────────────────────────────
        const sidebar = document.createElement('div');
        sidebar.style.cssText = 'width:190px;min-width:140px;max-width:260px;background:#161d27;border-right:1px solid #2e3d4e;overflow-y:auto;flex-shrink:0;padding:6px 0;';
        body.appendChild(sidebar);

        // ── Right folder-content panel ─────────────────────────────────────────
        const mainPanel = document.createElement('div');
        mainPanel.style.cssText = 'flex:1;overflow-y:auto;padding:6px 4px;min-width:0;';
        body.appendChild(mainPanel);

        // ── Footer ─────────────────────────────────────────────────────────────
        const footer = document.createElement('div');
        footer.style.cssText = 'display:flex;align-items:center;gap:10px;padding:9px 14px;background:#161d27;border-top:1px solid #2e3d4e;flex-shrink:0;';
        const selLabel = document.createElement('span');
        selLabel.style.cssText = 'flex:1;color:#7a9ab8;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-style:italic;';
        selLabel.textContent = 'Navigate to a folder, then click "Select Folder"';
        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'Cancel';
        cancelBtn.style.cssText = 'background:#2a3040;border:1px solid #3a4a5a;border-radius:6px;color:#9ab8d0;padding:7px 18px;font-size:13px;cursor:pointer;';
        const selectBtn = document.createElement('button');
        selectBtn.textContent = 'Select Folder';
        selectBtn.style.cssText = 'background:#2a6ea6;border:none;border-radius:6px;color:#fff;padding:7px 22px;font-size:13px;cursor:pointer;font-weight:700;letter-spacing:0.02em;';
        cancelBtn.onclick = () => done(null);
        selectBtn.onclick = () => { if (currentPath) done(currentPath); };
        footer.appendChild(selLabel);
        footer.appendChild(cancelBtn);
        footer.appendChild(selectBtn);
        modal.appendChild(footer);

        document.body.appendChild(overlay);

        // ── State ──────────────────────────────────────────────────────────────
        let currentPath    = null;
        let parentPath     = null;
        let historyStack   = [];   // paths navigated backward from
        let futureStack    = [];   // paths available to go forward to
        let quickAccessItems = []; // loaded once: home, desktop, common dirs
        let drives         = [];   // loaded once from /list-roots

        // ── Cleanup & resolve ──────────────────────────────────────────────────
        const done = (result) => {
            document.removeEventListener('keydown', onEsc);
            overlay.remove();
            resolve(result);
        };
        const onEsc = (e) => { if (e.key === 'Escape') done(null); };
        document.addEventListener('keydown', onEsc);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) done(null); });

        // ── Breadcrumb renderer ────────────────────────────────────────────────
        const renderBreadcrumbs = (path) => {
            breadcrumbWrap.innerHTML = '';
            if (!path) return;
            const norm = path.replace(/\\/g, '/');
            // Detect Windows drive root like C:
            const driveMatch = norm.match(/^([A-Za-z]:)(\/.*)?$/);
            let segments = [];
            let rootLabel = '';
            let rootPath  = '';

            if (driveMatch) {
                rootLabel = driveMatch[1].toUpperCase();
                rootPath  = driveMatch[1];
                const rest = (driveMatch[2] || '').replace(/^\//, '');
                segments = rest ? rest.split('/').filter(Boolean) : [];
            } else if (norm.startsWith('/')) {
                rootLabel = '/';
                rootPath  = '/';
                segments = norm.replace(/^\//, '').split('/').filter(Boolean);
            } else {
                // Relative — just show the whole thing as one segment
                const crumb = document.createElement('span');
                crumb.className = 'mpe-fpd-crumb last';
                crumb.textContent = path;
                breadcrumbWrap.appendChild(crumb);
                return;
            }

            const mkCrumb = (label, targetPath, isLast) => {
                const c = document.createElement('span');
                c.className = 'mpe-fpd-crumb' + (isLast ? ' last' : '');
                c.textContent = label;
                if (!isLast) c.addEventListener('click', (e) => { e.stopPropagation(); navigateTo(targetPath); });
                return c;
            };

            breadcrumbWrap.appendChild(mkCrumb(rootLabel, rootPath, segments.length === 0));

            let built = rootPath;
            segments.forEach((seg, i) => {
                const sep = document.createElement('span');
                sep.className = 'mpe-fpd-crumb-sep';
                sep.textContent = '›';
                breadcrumbWrap.appendChild(sep);
                built = built.replace(/\/$/, '') + '/' + seg;
                breadcrumbWrap.appendChild(mkCrumb(seg, built, i === segments.length - 1));
            });
        };

        // ── Navigate to a path ─────────────────────────────────────────────────
        const navigateTo = async (path, pushHistory = true) => {
            mainPanel.innerHTML = '<div style="color:#7a9ab8;font-size:13px;padding:24px;text-align:center;">Loading…</div>';
            try {
                const resp = await fetch(`/meta-prompt-extractor/browse?path=${encodeURIComponent(path)}&type=folders`);
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const data = await resp.json();

                if (pushHistory && currentPath && currentPath !== data.current) {
                    historyStack.push(currentPath);
                    futureStack = [];
                }

                currentPath = data.current;
                parentPath  = data.parent || null;

                // Update nav buttons
                backBtn.disabled  = historyStack.length === 0;
                fwdBtn.disabled   = futureStack.length  === 0;
                upBtn.disabled    = !parentPath;

                renderBreadcrumbs(currentPath);
                selLabel.textContent = currentPath;
                selLabel.style.fontStyle = 'normal';
                selLabel.style.color = '#a8dff0';

                renderMainPanel(data.entries || []);
                highlightSidebar(currentPath);
            } catch (err) {
                mainPanel.innerHTML = `<div style="color:#e07070;font-size:13px;padding:16px;">Error: ${err.message}</div>`;
            }
        };

        // ── Render the right folder-content panel ──────────────────────────────
        const renderMainPanel = (entries) => {
            mainPanel.innerHTML = '';
            const dirs = entries.filter(e => e.type === 'dir');
            if (dirs.length === 0) {
                mainPanel.innerHTML = '<div style="color:#5a7a98;font-size:13px;padding:24px;text-align:center;">No sub-folders here</div>';
                return;
            }
            for (const d of dirs) {
                const row = document.createElement('div');
                row.className = 'mpe-fpd-main-row';
                row.dataset.path = d.path;

                const arrowWrap = document.createElement('span');
                arrowWrap.className = 'mpe-fpd-arrow';
                arrowWrap.textContent = '▸';
                arrowWrap.title = 'Expand';

                const icon = document.createElement('span');
                icon.className = 'mpe-fpd-icon';
                icon.textContent = '📁';

                const label = document.createElement('span');
                label.className = 'mpe-fpd-label';
                label.textContent = d.name;

                row.appendChild(arrowWrap);
                row.appendChild(icon);
                row.appendChild(label);

                // Inline expand: clicking the arrow opens sub-rows beneath
                let expanded = false;
                let childContainer = null;

                arrowWrap.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    if (!expanded) {
                        arrowWrap.className = 'mpe-fpd-arrow open';
                        arrowWrap.textContent = '▾';
                        icon.textContent = '📂';
                        expanded = true;
                        if (!childContainer) {
                            childContainer = document.createElement('div');
                            childContainer.style.paddingLeft = '22px';
                            // Load sub-folders
                            childContainer.innerHTML = '<div style="color:#5a7a98;font-size:12px;padding:4px 8px;">Loading…</div>';
                            row.insertAdjacentElement('afterend', childContainer);
                            try {
                                const resp = await fetch(`/meta-prompt-extractor/browse?path=${encodeURIComponent(d.path)}&type=folders`);
                                const data = await resp.json();
                                childContainer.innerHTML = '';
                                const subs = (data.entries || []).filter(s => s.type === 'dir');
                                if (subs.length === 0) {
                                    childContainer.innerHTML = '<div style="color:#4a6a88;font-size:12px;padding:3px 8px;font-style:italic;">Empty</div>';
                                } else {
                                    for (const sub of subs) {
                                        childContainer.appendChild(makeInlineRow(sub, 1));
                                    }
                                }
                            } catch {
                                childContainer.innerHTML = '<div style="color:#e07070;font-size:12px;padding:3px 8px;">Error loading</div>';
                            }
                        } else {
                            childContainer.style.display = '';
                        }
                    } else {
                        arrowWrap.className = 'mpe-fpd-arrow';
                        arrowWrap.textContent = '▸';
                        icon.textContent = '📁';
                        expanded = false;
                        if (childContainer) childContainer.style.display = 'none';
                    }
                });

                // Single-click selects + highlights
                row.addEventListener('click', (e) => {
                    if (e.target === arrowWrap) return;
                    selectRow(row, d.path);
                });

                // Double-click navigates into
                row.addEventListener('dblclick', (e) => {
                    if (e.target === arrowWrap) return;
                    navigateTo(d.path);
                });

                mainPanel.appendChild(row);
            }
        };

        // Build a nested inline sub-row (same behaviour, deeper indent)
        const makeInlineRow = (entry, depth) => {
            const row = document.createElement('div');
            row.className = 'mpe-fpd-main-row';
            row.dataset.path = entry.path;
            row.style.paddingLeft = (12 + depth * 18) + 'px';

            const arrowWrap = document.createElement('span');
            arrowWrap.className = 'mpe-fpd-arrow';
            arrowWrap.textContent = '▸';

            const icon = document.createElement('span');
            icon.className = 'mpe-fpd-icon';
            icon.textContent = '📁';

            const label = document.createElement('span');
            label.className = 'mpe-fpd-label';
            label.textContent = entry.name;

            row.appendChild(arrowWrap);
            row.appendChild(icon);
            row.appendChild(label);

            let expanded = false;
            let childContainer = null;

            arrowWrap.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (!expanded) {
                    arrowWrap.className = 'mpe-fpd-arrow open';
                    arrowWrap.textContent = '▾';
                    icon.textContent = '📂';
                    expanded = true;
                    if (!childContainer) {
                        childContainer = document.createElement('div');
                        childContainer.innerHTML = '<div style="color:#5a7a98;font-size:12px;padding:3px 8px;">Loading…</div>';
                        row.insertAdjacentElement('afterend', childContainer);
                        try {
                            const resp = await fetch(`/meta-prompt-extractor/browse?path=${encodeURIComponent(entry.path)}&type=folders`);
                            const data = await resp.json();
                            childContainer.innerHTML = '';
                            const subs = (data.entries || []).filter(s => s.type === 'dir');
                            if (subs.length === 0) {
                                childContainer.innerHTML = '<div style="color:#4a6a88;font-size:12px;padding:3px 8px;font-style:italic;">Empty</div>';
                            } else {
                                for (const sub of subs) {
                                    childContainer.appendChild(makeInlineRow(sub, depth + 1));
                                }
                            }
                        } catch {
                            childContainer.innerHTML = '<div style="color:#e07070;font-size:12px;padding:3px 8px;">Error loading</div>';
                        }
                    } else {
                        childContainer.style.display = '';
                    }
                } else {
                    arrowWrap.className = 'mpe-fpd-arrow';
                    arrowWrap.textContent = '▸';
                    icon.textContent = '📁';
                    expanded = false;
                    if (childContainer) childContainer.style.display = 'none';
                }
            });

            row.addEventListener('click', (e) => {
                if (e.target === arrowWrap) return;
                selectRow(row, entry.path);
            });
            row.addEventListener('dblclick', (e) => {
                if (e.target === arrowWrap) return;
                navigateTo(entry.path);
            });

            return row;
        };

        // ── Select a folder row (highlights it, updates footer, does NOT navigate) ──
        const selectRow = (row, path) => {
            mainPanel.querySelectorAll('.mpe-fpd-main-row.active').forEach(r => r.classList.remove('active'));
            row.classList.add('active');
            currentPath = path;
            selLabel.textContent = path;
            selLabel.style.fontStyle = 'normal';
            selLabel.style.color = '#a8dff0';
            renderBreadcrumbs(path);
        };

        // ── Highlight matching sidebar item ────────────────────────────────────
        const highlightSidebar = (path) => {
            sidebar.querySelectorAll('.mpe-fpd-row.active').forEach(r => r.classList.remove('active'));
            const norm = (path || '').replace(/\\/g, '/').toLowerCase();
            sidebar.querySelectorAll('.mpe-fpd-row[data-path]').forEach(r => {
                const rp = (r.dataset.path || '').replace(/\\/g, '/').toLowerCase();
                if (rp === norm) r.classList.add('active');
            });
        };

        // ── Build the left sidebar ─────────────────────────────────────────────
        const buildSidebar = async () => {
            sidebar.innerHTML = '';

            const addSection = (label) => {
                const hdr = document.createElement('div');
                hdr.className = 'mpe-fpd-section-hdr';
                hdr.textContent = label;
                sidebar.appendChild(hdr);
            };

            const addRow = (icon, label, path, onClick) => {
                const row = document.createElement('div');
                row.className = 'mpe-fpd-row';
                if (path) row.dataset.path = path;
                const ico = document.createElement('span'); ico.className = 'mpe-fpd-icon'; ico.textContent = icon;
                const lbl = document.createElement('span'); lbl.className = 'mpe-fpd-label'; lbl.textContent = label;
                lbl.title = path || label;
                row.appendChild(ico); row.appendChild(lbl);
                row.addEventListener('click', onClick || (() => { if (path) navigateTo(path); }));
                sidebar.appendChild(row);
                return row;
            };

            const addDivider = () => {
                const d = document.createElement('div'); d.className = 'mpe-fpd-divider';
                sidebar.appendChild(d);
            };

            // ── Quick Access: home directory ──
            addSection('Quick Access');
            try {
                const r = await fetch('/meta-prompt-extractor/browse?type=folders');
                const d = await r.json();
                if (d.current) {
                    addRow('🏠', 'Home', d.current);
                    // Try to infer Desktop / Documents / Pictures from home
                    const home = d.current.replace(/\\/g, '/');
                    const commonDirs = [
                        { icon: '🖥️', name: 'Desktop',   rel: 'Desktop'   },
                        { icon: '📄', name: 'Documents',  rel: 'Documents' },
                        { icon: '🖼️', name: 'Pictures',   rel: 'Pictures'  },
                        { icon: '📥', name: 'Downloads',  rel: 'Downloads' },
                        { icon: '🎬', name: 'Videos',     rel: 'Videos'    },
                    ];
                    for (const cd of commonDirs) {
                        const candidate = home.replace(/\/$/, '') + '/' + cd.rel;
                        // Speculatively show; they'll simply show a "no subfolders" if missing
                        addRow(cd.icon, cd.name, candidate);
                    }
                }
            } catch {}

            addDivider();

            // ── Drives / root ──
            addSection('This PC');
            try {
                const r = await fetch('/meta-prompt-extractor/list-roots');
                const d = await r.json();
                drives = d.roots || [];
                for (const drv of drives) {
                    const label = drv.length <= 3 ? drv : drv; // show as-is
                    const icon  = drv.startsWith('/') ? '🗂️' : '💾';
                    addRow(icon, label, drv);
                }
            } catch {
                addRow('💾', 'C:\\', 'C:');
            }

            addDivider();

            // ── Network / special ──
            addSection('Other');
            addRow('🌐', 'Network…', null, async () => {
                // Try \\ (UNC root) or /net on Unix
                navigateTo('//');
            });
            addRow('💾', 'All Drives', null, async () => {
                // Show drives in main panel
                mainPanel.innerHTML = '';
                for (const drv of drives) {
                    const icon  = drv.startsWith('/') ? '🗂️' : '💾';
                    const row = document.createElement('div');
                    row.className = 'mpe-fpd-main-row';
                    row.dataset.path = drv;
                    const ic = document.createElement('span'); ic.className = 'mpe-fpd-icon'; ic.textContent = icon;
                    const lbl = document.createElement('span'); lbl.className = 'mpe-fpd-label'; lbl.textContent = drv;
                    row.appendChild(ic); row.appendChild(lbl);
                    row.addEventListener('click', () => selectRow(row, drv));
                    row.addEventListener('dblclick', () => navigateTo(drv));
                    mainPanel.appendChild(row);
                }
                currentPath = null;
                selLabel.textContent = 'Choose a drive';
                selLabel.style.fontStyle = 'italic';
                selLabel.style.color = '#7a9ab8';
                breadcrumbWrap.innerHTML = '';
                backBtn.disabled = historyStack.length === 0;
            });
        };

        // ── Navigation history buttons ─────────────────────────────────────────
        backBtn.addEventListener('click', () => {
            if (!historyStack.length) return;
            futureStack.push(currentPath);
            const prev = historyStack.pop();
            navigateTo(prev, false);
        });
        fwdBtn.addEventListener('click', () => {
            if (!futureStack.length) return;
            historyStack.push(currentPath);
            const next = futureStack.pop();
            navigateTo(next, false);
        });
        upBtn.addEventListener('click', () => { if (parentPath) navigateTo(parentPath); });
        drivesBtn.addEventListener('click', async () => {
            // Show drives in main panel
            if (currentPath) historyStack.push(currentPath);
            futureStack = [];
            mainPanel.innerHTML = '';
            for (const drv of drives) {
                const icon = drv.startsWith('/') ? '🗂️' : '💾';
                const row  = document.createElement('div');
                row.className = 'mpe-fpd-main-row';
                row.dataset.path = drv;
                const ic = document.createElement('span'); ic.className = 'mpe-fpd-icon'; ic.textContent = icon;
                const lbl = document.createElement('span'); lbl.className = 'mpe-fpd-label'; lbl.textContent = drv;
                row.appendChild(ic); row.appendChild(lbl);
                row.addEventListener('click', () => selectRow(row, drv));
                row.addEventListener('dblclick', () => navigateTo(drv));
                mainPanel.appendChild(row);
            }
            breadcrumbWrap.innerHTML = '';
            const allDrivesCrumb = document.createElement('span');
            allDrivesCrumb.className = 'mpe-fpd-crumb last';
            allDrivesCrumb.textContent = '💾 This PC';
            breadcrumbWrap.appendChild(allDrivesCrumb);
            currentPath = null;
            parentPath  = null;
            upBtn.disabled  = true;
            backBtn.disabled = historyStack.length === 0;
            fwdBtn.disabled  = futureStack.length  === 0;
            selLabel.textContent = 'Select a drive to browse';
            selLabel.style.fontStyle = 'italic';
            selLabel.style.color = '#7a9ab8';
            highlightSidebar('');
        });

        // ── Bootstrap ─────────────────────────────────────────────────────────
        buildSidebar().then(() => {
            // Start at home directory
            fetch('/meta-prompt-extractor/browse?type=folders')
                .then(r => r.json())
                .then(d => navigateTo(d.current, false))
                .catch(() => navigateTo('/', false));
        });
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Context Menu System — Right-Click Power-User Features
// ─────────────────────────────────────────────────────────────────────────────

let _activeContextMenu = null; // Track active context menu to prevent duplicates

/**
 * Create and display a context menu for files/folders
 * Features: Copy path, Open in Explorer, Add/Remove from favorites
 */
function showContextMenu(event, filePath, isDir, getBookmarks, addBookmark, removeBookmark, renderBookmarks, navigateCallback) {
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

    // ─── File-only actions (non-directory) ───
    if (!isDir) {
        // Separator
        const sep = document.createElement('div');
        sep.style.cssText = 'height:1px;background:#2e3d4e;margin:4px 0;';
        menu.appendChild(sep);

        // Rename
        menu.appendChild(createMenuItem('Rename', '✏️', async () => {
            const filename = filePath.replace(/\\/g, '/').split('/').pop();
            const newName = prompt('Enter new filename:', filename);
            if (!newName || newName === filename) return;
            try {
                const res = await fetch('/meta-prompt-extractor/rename-file', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ old_path: filePath, new_name: newName })
                });
                const data = await res.json();
                if (data.status === 'ok') {
                    // Re-navigate to refresh directory listing
                    if (navigateCallback) navigateCallback();
                } else { alert('Rename failed: ' + (data.message || 'Unknown error')); }
            } catch (e) { alert('Rename error: ' + e); }
        }));

        // Copy to… — opens a folder-picker dialog
        menu.appendChild(createMenuItem('Copy to…', '📋➔', async () => {
            const dest = await _openFolderPickerDialog('Select destination folder to copy to');
            if (!dest) return;
            try {
                const res = await fetch('/meta-prompt-extractor/copy-files', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ source_paths: [filePath], destination_dir: dest })
                });
                const data = await res.json();
                if (data.status === 'ok' || data.status === 'partial') {
                    if (data.errors && data.errors.length > 0) alert('Copy errors:\n' + data.errors.join('\n'));
                    // No navigate — source file stays where it is
                } else { alert('Copy failed: ' + (data.message || 'Unknown error')); }
            } catch (e) { alert('Copy error: ' + e); }
        }));

        // Move to… — opens a folder-picker dialog
        menu.appendChild(createMenuItem('Move to…', '➔', async () => {
            const dest = await _openFolderPickerDialog('Select destination folder to move to');
            if (!dest) return;
            try {
                const res = await fetch('/meta-prompt-extractor/move-files', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ source_paths: [filePath], destination_dir: dest })
                });
                const data = await res.json();
                if (data.status === 'ok' || data.status === 'partial') {
                    if (data.errors && data.errors.length > 0) alert('Move errors:\n' + data.errors.join('\n'));
                    if (navigateCallback) navigateCallback();  // file is gone — refresh view
                } else { alert('Move failed: ' + (data.message || 'Unknown error')); }
            } catch (e) { alert('Move error: ' + e); }
        }));

        // Delete (to trash)
        const deleteItem = createMenuItem('Delete (to trash)', '🗑️', async () => {
            if (!confirm(`Delete "${filePath.replace(/\\/g, '/').split('/').pop()}"?\nIt will be sent to the Recycle Bin.`)) return;
            try {
                const res = await fetch('/meta-prompt-extractor/delete-files', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ filepaths: [filePath] })
                });
                const data = await res.json();
                if (data.status === 'ok' || data.status === 'partial') {
                    if (data.errors && data.errors.length > 0) alert('Delete errors:\n' + data.errors.join('\n'));
                    if (navigateCallback) navigateCallback();
                } else { alert('Delete failed: ' + (data.message || 'Unknown error')); }
            } catch (e) { alert('Delete error: ' + e); }
        });
        deleteItem.style.color = '#e07070';
        menu.appendChild(deleteItem);

        // Mask Editor (images only)
        const ext = filePath.replace(/\\/g, '/').split('/').pop().split('.').pop().toLowerCase();
        if (['png', 'jpg', 'jpeg', 'webp'].includes(ext)) {
            const sep2 = document.createElement('div');
            sep2.style.cssText = 'height:1px;background:#2e3d4e;margin:4px 0;';
            menu.appendChild(sep2);
            menu.appendChild(createMenuItem('Open Mask Editor', '🎭', () => {
                if (window.mpeOpenMaskEditor) {
                    window.mpeOpenMaskEditor(filePath, () => {
                        if (navigateCallback) navigateCallback();
                    });
                }
            }));
        }
    }
    
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


// ─────────────────────────────────────────────────────────────────────────────
// Lightweight Mask Editor — Meta Prompt Extractor
// Controls: Draw (Left Click), Erase (Shift+Left), Pan (Middle), Zoom (Wheel)
// ─────────────────────────────────────────────────────────────────────────────

let _mpe_mask_on_save_callback = null;
let _mpe_mask_editor_initialized = false;

function setupMpeGlobalMaskEditor() {
    if (_mpe_mask_editor_initialized) return;
    _mpe_mask_editor_initialized = true;

    const css = `
        .mpe-mask-editor-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.85); z-index: 10010; display: none; flex-direction: column; align-items: center; justify-content: center; }
        .mpe-mask-editor-container { position: relative; background: #222; border: 1px solid #444; padding: 10px; border-radius: 8px; display: flex; flex-direction: column; height: 90vh; width: 90vw; }
        .mpe-mask-editor-toolbar { display: flex; gap: 10px; margin-bottom: 10px; align-items: center; color: #ddd; flex-shrink: 0; }
        .mpe-mask-editor-canvas-wrapper { position: relative; overflow: hidden; background: #333; cursor: none; flex-grow: 1; }
        .mpe-mask-editor-actions { margin-top: 10px; display: flex; justify-content: flex-end; gap: 10px; flex-shrink: 0; align-items: center; }
        .mpe-mask-editor-btn-primary { background: #236694; color: white; border: none; padding: 5px 15px; border-radius: 4px; cursor: pointer; }
        .mpe-mask-editor-btn-secondary { background: #444; color: white; border: none; padding: 5px 15px; border-radius: 4px; cursor: pointer; }
        .mpe-brush-cursor { position: absolute; border: 1px solid rgba(255,255,255,0.9); box-shadow: 0 0 2px 1px rgba(0,0,0,0.8); border-radius: 50%; pointer-events: none; z-index: 10003; transform: translate(-50%, -50%); display: none; }
        .mpe-mask-editor-toolbar select, .mpe-mask-editor-toolbar input[type=range] { background: #333; color: #eee; border: 1px solid #555; border-radius: 4px; padding: 2px 4px; }
        .mpe-mask-editor-toolbar button { background: #444; color: #eee; border: 1px solid #555; border-radius: 4px; padding: 4px 10px; cursor: pointer; }
        .mpe-mask-editor-toolbar button:hover { background: #555; }
    `;
    const styleEl = document.createElement('style');
    styleEl.textContent = css;
    document.head.appendChild(styleEl);

    const html = `
        <div id="mpe-mask-editor" class="mpe-mask-editor-overlay">
            <div class="mpe-mask-editor-container">
                <div class="mpe-mask-editor-toolbar">
                    <label>Size:</label> <input type="range" id="mpe-mask-brush-size" min="1" max="100" value="20" title="Brush Size">
                    <label style="margin-left:10px;">Softness:</label>
                    <input type="range" id="mpe-mask-brush-blur" min="0" max="50" value="0" title="Edge Softness">
                    <label style="margin-left:10px;">Color:</label>
                    <select id="mpe-mask-display-mode" title="Mask Overlay Style">
                        <option value="difference">Difference</option>
                        <option value="white">White</option>
                        <option value="black" selected>Black</option>
                    </select>
                    <button id="mpe-mask-clear" style="margin-left:10px;">Clear</button>
                    <button id="mpe-mask-invert">Invert</button>
                    <span style="font-size:12px;color:#888;margin-left:auto;">Left: Draw | Shift+Left: Erase | Middle: Pan | Wheel: Zoom</span>
                </div>
                <div id="mpe-mask-viewport" class="mpe-mask-editor-canvas-wrapper">
                    <div id="mpe-brush-cursor" class="mpe-brush-cursor"></div>
                    <div id="mpe-mask-content" style="position:absolute;top:0;left:0;transform-origin:0 0;">
                        <img id="mpe-mask-bg-img" style="display:block;pointer-events:none;user-select:none;">
                        <canvas id="mpe-mask-canvas" style="position:absolute;top:0;left:0;"></canvas>
                    </div>
                </div>
                <div class="mpe-mask-editor-actions">
                    <div id="mpe-mask-info" style="position:absolute;bottom:14px;left:10px;color:#eee;background:rgba(0,0,0,0.6);padding:4px 8px;border-radius:4px;font-size:14px;pointer-events:none;user-select:none;z-index:10002;font-family:monospace;">0 x 0 | 100%</div>
                    <button id="mpe-mask-cancel" class="mpe-mask-editor-btn-secondary">Cancel</button>
                    <button id="mpe-mask-save" class="mpe-mask-editor-btn-primary">Save Mask</button>
                </div>
            </div>
        </div>
    `;
    document.body.insertAdjacentHTML('beforeend', html);

    const overlay     = document.getElementById('mpe-mask-editor');
    const viewport    = document.getElementById('mpe-mask-viewport');
    const content     = document.getElementById('mpe-mask-content');
    const bgImg       = document.getElementById('mpe-mask-bg-img');
    const maskCanvas  = document.getElementById('mpe-mask-canvas');
    const maskCtx     = maskCanvas.getContext('2d');
    const brushCursor = document.getElementById('mpe-brush-cursor');

    let editorState = { zoom: 1, panX: 0, panY: 0, isPanning: false, panStartX: 0, panStartY: 0 };
    let isDrawingMask = false;
    let currentImagePath = '';

    const updateTransform = () => {
        content.style.transform = `translate(${editorState.panX}px, ${editorState.panY}px) scale(${editorState.zoom})`;
    };
    const updateCursor = (e) => {
        if (!e || editorState.isPanning) {
            viewport.style.cursor = editorState.isPanning ? 'grabbing' : 'default';
            brushCursor.style.display = 'none'; return;
        }
        const rect = viewport.getBoundingClientRect();
        const x = e.clientX - rect.left, y = e.clientY - rect.top;
        if (x < 0 || y < 0 || x > rect.width || y > rect.height) { brushCursor.style.display = 'none'; return; }
        viewport.style.cursor = 'none';
        brushCursor.style.display = 'block';
        brushCursor.style.left = x + 'px'; brushCursor.style.top = y + 'px';
        const size = document.getElementById('mpe-mask-brush-size').value * editorState.zoom;
        brushCursor.style.width = size + 'px'; brushCursor.style.height = size + 'px';
    };
    const getMousePos = (e) => {
        const rect = viewport.getBoundingClientRect();
        return { x: (e.clientX - rect.left - editorState.panX) / editorState.zoom, y: (e.clientY - rect.top - editorState.panY) / editorState.zoom };
    };
    const drawMask = (e) => {
        if (!isDrawingMask) return;
        e.preventDefault();
        const pos = getMousePos(e);
        const size = document.getElementById('mpe-mask-brush-size').value;
        const blur = document.getElementById('mpe-mask-brush-blur').value;
        maskCtx.lineWidth = size; maskCtx.lineCap = 'round'; maskCtx.lineJoin = 'round';
        maskCtx.shadowBlur = blur; maskCtx.shadowColor = 'white';
        maskCtx.globalCompositeOperation = e.shiftKey ? 'destination-out' : 'source-over';
        maskCtx.strokeStyle = 'white'; maskCtx.fillStyle = 'white';
        maskCtx.lineTo(pos.x, pos.y); maskCtx.stroke();
        maskCtx.beginPath(); maskCtx.arc(pos.x, pos.y, maskCtx.lineWidth / 2, 0, Math.PI * 2); maskCtx.fill();
        maskCtx.beginPath(); maskCtx.moveTo(pos.x, pos.y);
        maskCtx.shadowBlur = 0;
    };

    viewport.addEventListener('wheel', (e) => {
        e.preventDefault();
        const rect = viewport.getBoundingClientRect();
        const mxw = (e.clientX - rect.left - editorState.panX) / editorState.zoom;
        const myw = (e.clientY - rect.top  - editorState.panY) / editorState.zoom;
        const newZoom = e.deltaY < 0 ? editorState.zoom * 1.1 : editorState.zoom / 1.1;
        if (newZoom < 0.1 || newZoom > 20) return;
        editorState.zoom = newZoom;
        editorState.panX = (e.clientX - rect.left) - mxw * editorState.zoom;
        editorState.panY = (e.clientY - rect.top)  - myw * editorState.zoom;
        updateTransform(); updateCursor(e);
        document.getElementById('mpe-mask-info').textContent = `${maskCanvas.width} x ${maskCanvas.height} | ${Math.round(editorState.zoom * 100)}%`;
    });
    viewport.addEventListener('mousedown', (e) => {
        if (e.button === 1) { editorState.isPanning = true; editorState.panStartX = e.clientX; editorState.panStartY = e.clientY; }
        else if (e.button === 0) { isDrawingMask = true; maskCtx.beginPath(); drawMask(e); }
        updateCursor(e);
    });
    window.addEventListener('mousemove', (e) => {
        if (editorState.isPanning) {
            editorState.panX += e.clientX - editorState.panStartX; editorState.panY += e.clientY - editorState.panStartY;
            editorState.panStartX = e.clientX; editorState.panStartY = e.clientY; updateTransform();
        } else if (isDrawingMask) drawMask(e);
        if (viewport.contains(e.target)) updateCursor(e); else brushCursor.style.display = 'none';
    });
    window.addEventListener('mouseup', (e) => { editorState.isPanning = false; isDrawingMask = false; maskCtx.beginPath(); updateCursor(e); });
    viewport.addEventListener('contextmenu', (e) => e.preventDefault());

    document.getElementById('mpe-mask-cancel').onclick = () => { overlay.style.display = 'none'; };

    document.getElementById('mpe-mask-save').onclick = async () => {
        const dataUrl = maskCanvas.toDataURL('image/png');
        const btn = document.getElementById('mpe-mask-save'); btn.textContent = 'Saving…'; btn.disabled = true;
        try {
            const saveRes = await fetch('/meta-prompt-extractor/save-mask', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ image_path: currentImagePath, mask_data: dataUrl })
            });
            const saveData = await saveRes.json();
            if (saveData.status !== 'ok') {
                alert('Save mask failed: ' + (saveData.message || 'Unknown error'));
                return;
            }
            // Notify all active MetaPromptExtractor nodes that their mask has changed.
            // This re-assigns the widget value to itself, which forces ComfyUI to
            // re-query IS_CHANGED on the next queue, picking up the new mask file.
            _mpe_notifyMaskSaved(currentImagePath);
            if (_mpe_mask_on_save_callback) _mpe_mask_on_save_callback();
            overlay.style.display = 'none';
        } catch (e) { alert('Failed to save mask: ' + e); }
        finally { btn.textContent = 'Save Mask'; btn.disabled = false; }
    };

    document.getElementById('mpe-mask-clear').onclick = () => {
        maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
    };

    document.getElementById('mpe-mask-invert').onclick = () => {
        const iD = maskCtx.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
        const d = iD.data;
        for (let i = 0; i < d.length; i += 4) {
            d[i + 3] = 255 - d[i + 3]; d[i] = 255; d[i + 1] = 255; d[i + 2] = 255;
        }
        maskCtx.putImageData(iD, 0, 0);
    };

    const displaySelect = document.getElementById('mpe-mask-display-mode');
    const updateMaskVisuals = () => {
        const mode = displaySelect.value;
        if (mode === 'difference') {
            maskCanvas.style.mixBlendMode = 'difference'; maskCanvas.style.opacity = '1'; maskCanvas.style.filter = 'none';
        } else if (mode === 'white') {
            maskCanvas.style.mixBlendMode = 'normal'; maskCanvas.style.opacity = '0.75'; maskCanvas.style.filter = 'none';
        } else if (mode === 'black') {
            maskCanvas.style.mixBlendMode = 'normal'; maskCanvas.style.opacity = '0.75'; maskCanvas.style.filter = 'invert(1)';
        }
    };
    displaySelect.addEventListener('change', updateMaskVisuals);
    updateMaskVisuals();

    window.mpeOpenMaskEditor = async (path, onSaveCallback) => {
        currentImagePath = path;
        _mpe_mask_on_save_callback = onSaveCallback;
        const timestamp = Date.now();
        const img = new Image();
        img.onload = async () => {
            overlay.style.display = 'flex';
            maskCanvas.width = img.width; maskCanvas.height = img.height;
            maskCanvas.style.width = img.width + 'px'; maskCanvas.style.height = img.height + 'px';
            bgImg.src = img.src;
            const vW = viewport.clientWidth, vH = viewport.clientHeight;
            let scale = Math.min(vW / img.width, vH / img.height) * 0.9;
            editorState.zoom = scale || 1;
            editorState.panX = (vW - img.width  * editorState.zoom) / 2;
            editorState.panY = (vH - img.height * editorState.zoom) / 2;
            updateTransform();
            document.getElementById('mpe-mask-info').textContent = `${img.width} x ${img.height} | ${Math.round(editorState.zoom * 100)}%`;

            try {
                const res  = await fetch('/meta-prompt-extractor/get-mask-path', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ image_path: path })
                });
                const data = await res.json();
                maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);

                if (data.status === 'ok' && data.mask_path) {
                    const mImg = new Image();
                    mImg.onload = () => {
                        maskCtx.drawImage(mImg, 0, 0);
                        const iD = maskCtx.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
                        for (let i = 0; i < iD.data.length; i += 4) {
                            const alpha = iD.data[i + 3] < 255 ? iD.data[i + 3] : iD.data[i];
                            iD.data[i] = 255; iD.data[i + 1] = 255; iD.data[i + 2] = 255; iD.data[i + 3] = alpha;
                        }
                        maskCtx.putImageData(iD, 0, 0);
                    };
                    mImg.src = `/meta-prompt-extractor/serve-file?path=${encodeURIComponent(data.mask_path)}&t=${timestamp}`;
                } else {
                    // Auto-mask from alpha channel
                    const tempCanvas = document.createElement('canvas');
                    tempCanvas.width = img.width; tempCanvas.height = img.height;
                    const tempCtx = tempCanvas.getContext('2d');
                    tempCtx.drawImage(img, 0, 0);
                    const origData = tempCtx.getImageData(0, 0, img.width, img.height).data;
                    const maskImageData = maskCtx.createImageData(maskCanvas.width, maskCanvas.height);
                    const maskPixels = maskImageData.data;
                    let hasTransparency = false;
                    for (let i = 0; i < origData.length; i += 4) {
                        const maskAlpha = 255 - origData[i + 3];
                        if (maskAlpha > 0) {
                            maskPixels[i] = 255; maskPixels[i + 1] = 255; maskPixels[i + 2] = 255; maskPixels[i + 3] = maskAlpha;
                            hasTransparency = true;
                        }
                    }
                    if (hasTransparency) maskCtx.putImageData(maskImageData, 0, 0);
                }
            } catch (e) { console.error('[MpeEditor]', e); }
        };
        img.src = `/meta-prompt-extractor/serve-file?path=${encodeURIComponent(path)}&t=${timestamp}`;
    };
}
setupMpeGlobalMaskEditor();

// ─── Node registry + mask-save notifier ──────────────────────────────────────
// Every MetaPromptExtractor node registers itself here on creation.
// When a mask is saved/cleared we iterate the registry and re-dirty the widget
// of any node whose currently-selected image path matches, so that ComfyUI
// re-queries IS_CHANGED on the next prompt queue.
window._mpe_nodeRegistry = window._mpe_nodeRegistry || new Set();

function _mpe_notifyMaskSaved(savedImagePath) {
    for (const nodeRef of window._mpe_nodeRegistry) {
        try {
            const node = nodeRef.deref ? nodeRef.deref() : nodeRef;
            if (!node) { window._mpe_nodeRegistry.delete(nodeRef); continue; }
            const imgWidget = node.widgets?.find(w => w.name === 'image');
            if (!imgWidget) continue;
            const nodePath = (imgWidget.value || '').replace(/\\/g, '/');
            const maskPath = (savedImagePath || '').replace(/\\/g, '/');
            if (nodePath === maskPath) {
                // Re-assign value to itself — marks widget dirty so IS_CHANGED
                // is re-evaluated on next queue without changing the user's selection.
                const cur = imgWidget.value;
                imgWidget.value = '';
                imgWidget.value = cur;
                node.setDirtyCanvas(true, true);
                console.log('[MetaPromptExtractor] Notified node of mask change:', nodePath);
            }
        } catch (e) {
            console.warn('[MetaPromptExtractor] Error notifying node:', e);
        }
    }
}

async function createFileBrowserModal(currentFile, onSelect) {
    // ─── Bookmark Management ───
    const BOOKMARKS_KEY   = "metaPromptExtractor_bookmarks";

    // ─── Persistent UI State ──────────────────────────────────────────────────
    // Everything the user has arranged in the window (size, position, panel
    // states) is stored under a single localStorage key as a JSON object so we
    // can save / restore it atomically.
    const UI_STATE_KEY = "metaPromptExtractor_uiState";

    const loadUIState = () => {
        try {
            const raw = localStorage.getItem(UI_STATE_KEY);
            return raw ? JSON.parse(raw) : {};
        } catch { return {}; }
    };

    const saveUIState = (patch) => {
        try {
            const current = loadUIState();
            localStorage.setItem(UI_STATE_KEY, JSON.stringify({ ...current, ...patch }));
        } catch (e) {
            console.warn("[MetaPromptExtractor] Failed to save UI state:", e);
        }
    };

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

    // ── Initial size & centered position — restored from saved state if present ──
    const _uiState = loadUIState();
    const INIT_W = _uiState.modalW || Math.min(900, Math.round(window.innerWidth  * 0.96));
    const INIT_H = _uiState.modalH || Math.min(520, Math.round(window.innerHeight * 0.90));
    const INIT_X = _uiState.modalX != null
        ? Math.min(_uiState.modalX, window.innerWidth  - INIT_W)
        : Math.round((window.innerWidth  - INIT_W) / 2);
    const INIT_Y = _uiState.modalY != null
        ? Math.min(_uiState.modalY, window.innerHeight - INIT_H)
        : Math.round((window.innerHeight - INIT_H) / 2);
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
            saveUIState({ modalX: modal.offsetLeft, modalY: modal.offsetTop });
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
            saveUIState({ modalW: modal.offsetWidth, modalH: modal.offsetHeight });
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
    const SIDEBAR_MIN_W = 100;
    const SIDEBAR_MAX_W = 340;
    const _savedSidebarW = _uiState.sidebarW
        ? Math.min(SIDEBAR_MAX_W, Math.max(SIDEBAR_MIN_W, _uiState.sidebarW))
        : 160;
    const sidebar = document.createElement('div');
    sidebar.style.cssText = `width:${_savedSidebarW}px;background:#161d27;overflow-y:auto;display:flex;flex-direction:column;flex-shrink:0;position:relative;`;

    const bookmarksTitle = document.createElement('div');
    bookmarksTitle.style.cssText = 'padding:10px 8px;font-size:12px;color:#7a9ab8;font-weight:700;text-transform:uppercase;border-bottom:1px solid #2e3d4e;flex-shrink:0;';
    bookmarksTitle.textContent = '⭐ Favorites';
    sidebar.appendChild(bookmarksTitle);

    const bookmarksList = document.createElement('div');
    bookmarksList.style.cssText = 'flex:1;overflow-y:auto;position:relative;';
    sidebar.appendChild(bookmarksList);

    // ── Sidebar resize handle (right edge) ──
    const sidebarResizeHandle = document.createElement('div');
    sidebarResizeHandle.style.cssText = 'position:absolute;top:0;right:0;width:5px;height:100%;cursor:col-resize;z-index:10;background:transparent;transition:background 0.15s;';
    sidebarResizeHandle.title = 'Drag to resize favorites panel';
    sidebarResizeHandle.onmouseenter = () => { sidebarResizeHandle.style.background = 'rgba(74,144,217,0.35)'; };
    sidebarResizeHandle.onmouseleave = () => { sidebarResizeHandle.style.background = 'transparent'; };
    sidebarResizeHandle.addEventListener('mousedown', (mde) => {
        mde.preventDefault();
        mde.stopPropagation();
        const startX   = mde.clientX;
        const startW   = sidebar.offsetWidth;
        const onMove   = (mme) => {
            const newW = Math.min(SIDEBAR_MAX_W, Math.max(SIDEBAR_MIN_W, startW + (mme.clientX - startX)));
            sidebar.style.width = newW + 'px';
        };
        const onUp = () => {
            sidebarResizeHandle.style.background = 'transparent';
            saveUIState({ sidebarW: sidebar.offsetWidth });
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup',   onUp);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup',   onUp);
    });
    sidebar.appendChild(sidebarResizeHandle);

    // Thin visual divider on the right of the sidebar (sits on top of the handle)
    const sidebarBorder = document.createElement('div');
    sidebarBorder.style.cssText = 'position:absolute;top:0;right:0;width:1px;height:100%;background:#2e3d4e;pointer-events:none;';
    sidebar.appendChild(sidebarBorder);

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
    const METADATA_PANEL_W = 280; // stored width when expanded
    let _metadataPanelCollapsed = !!_uiState.metadataCollapsed;

    const metadataPanel = document.createElement('div');
    metadataPanel.style.cssText = `width:${METADATA_PANEL_W}px;background:#161d27;border-left:1px solid #2e3d4e;overflow:hidden;display:flex;flex-direction:column;flex-shrink:0;transition:width 0.2s ease;`;

    const metadataHeader = document.createElement('div');
    metadataHeader.style.cssText = 'padding:10px 8px 10px 12px;font-size:12px;color:#7a9ab8;font-weight:700;text-transform:uppercase;border-bottom:1px solid #2e3d4e;flex-shrink:0;display:flex;align-items:center;gap:6px;';

    const metadataHeaderLabel = document.createElement('span');
    metadataHeaderLabel.style.cssText = 'flex:1;white-space:nowrap;overflow:hidden;';
    metadataHeaderLabel.textContent = '📋 Metadata';
    metadataHeader.appendChild(metadataHeaderLabel);

    // Collapse / expand button
    const metadataCollapseBtn = document.createElement('button');
    metadataCollapseBtn.title = 'Collapse metadata panel';
    metadataCollapseBtn.style.cssText = 'background:none;border:none;color:#7a9ab8;cursor:pointer;font-size:13px;padding:2px 4px;border-radius:4px;line-height:1;flex-shrink:0;transition:color 0.15s,background 0.15s;';
    metadataCollapseBtn.textContent = '›';
    metadataCollapseBtn.onmouseenter = () => { metadataCollapseBtn.style.color = '#c8dff0'; metadataCollapseBtn.style.background = 'rgba(255,255,255,0.07)'; };
    metadataCollapseBtn.onmouseleave = () => { metadataCollapseBtn.style.color = '#7a9ab8'; metadataCollapseBtn.style.background = 'none'; };
    metadataHeader.appendChild(metadataCollapseBtn);

    metadataPanel.appendChild(metadataHeader);

    const metadataContent = document.createElement('div');
    metadataContent.style.cssText = 'flex:1;overflow-y:auto;padding:10px 12px;font-size:12px;';
    metadataPanel.appendChild(metadataContent);

    // ── Collapsed-state tab (vertical label on the left edge of the panel) ──
    const metadataTab = document.createElement('div');
    metadataTab.style.cssText = 'display:none;position:absolute;right:0;top:50%;transform:translateY(-50%);writing-mode:vertical-rl;text-orientation:mixed;background:#161d27;border:1px solid #2e3d4e;border-right:none;border-radius:6px 0 0 6px;padding:10px 5px;color:#7a9ab8;font-size:11px;font-weight:700;text-transform:uppercase;cursor:pointer;user-select:none;letter-spacing:0.08em;transition:color 0.15s,background 0.15s;';
    metadataTab.textContent = '📋 Metadata';
    metadataTab.title = 'Expand metadata panel';
    metadataTab.onmouseenter = () => { metadataTab.style.color = '#c8dff0'; metadataTab.style.background = '#1e2a38'; };
    metadataTab.onmouseleave = () => { metadataTab.style.color = '#7a9ab8'; metadataTab.style.background = '#161d27'; };

    // mainContent needs position:relative for the tab absolute positioning
    mainContent.style.position = 'relative';

    const _toggleMetadataPanel = () => {
        _metadataPanelCollapsed = !_metadataPanelCollapsed;
        saveUIState({ metadataCollapsed: _metadataPanelCollapsed });
        if (_metadataPanelCollapsed) {
            metadataPanel.style.width = '0px';
            metadataPanel.style.borderLeftWidth = '0px';
            metadataCollapseBtn.textContent = '‹';
            metadataCollapseBtn.title = 'Expand metadata panel';
            metadataContent.style.display = 'none';
            metadataHeaderLabel.style.display = 'none';
            metadataCollapseBtn.style.display = 'none';
            metadataTab.style.display = 'block';
        } else {
            metadataPanel.style.width = METADATA_PANEL_W + 'px';
            metadataPanel.style.borderLeftWidth = '1px';
            metadataCollapseBtn.textContent = '›';
            metadataCollapseBtn.title = 'Collapse metadata panel';
            metadataContent.style.display = '';
            metadataHeaderLabel.style.display = '';
            metadataCollapseBtn.style.display = '';
            metadataTab.style.display = 'none';
        }
    };

    metadataCollapseBtn.onclick = (e) => { e.stopPropagation(); _toggleMetadataPanel(); };
    metadataTab.onclick = () => _toggleMetadataPanel();

    // Apply saved collapsed state immediately (no animation on open)
    if (_metadataPanelCollapsed) {
        metadataPanel.style.transition = 'none';
        metadataPanel.style.width = '0px';
        metadataPanel.style.borderLeftWidth = '0px';
        metadataCollapseBtn.textContent = '‹';
        metadataCollapseBtn.title = 'Expand metadata panel';
        metadataContent.style.display = 'none';
        metadataHeaderLabel.style.display = 'none';
        metadataCollapseBtn.style.display = 'none';
        metadataTab.style.display = 'block';
        // Re-enable transition after first paint
        requestAnimationFrame(() => { metadataPanel.style.transition = 'width 0.2s ease'; });
    }

    mainContent.appendChild(metadataPanel);
    mainContent.appendChild(metadataTab);
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
    const maskEditorBtn = document.createElement('button');
    maskEditorBtn.textContent = '🎭 Mask Editor';
    maskEditorBtn.title = 'Open mask editor for the selected image';
    maskEditorBtn.style.cssText = 'background:#2a3040;border:1px solid #3a4a5a;border-radius:6px;color:#9ab8d0;padding:7px 12px;font-size:13px;cursor:pointer;';
    maskEditorBtn.disabled = true;
    maskEditorBtn.style.opacity = '0.5';
    footer.appendChild(selectedLabel);
    footer.appendChild(maskEditorBtn);
    footer.appendChild(cancelBtn);
    footer.appendChild(selectBtn);
    modal.appendChild(footer);

    let currentPath = null;
    // Prefer the persisted last-selected file; fall back to currentFile passed by caller
    let selectedPath = _uiState.lastSelectedFile || ((currentFile && isAbsolutePath(currentFile)) ? currentFile : null);
    let currentBrowseData = null;
    // Track whether the last navigation came from a bookmark click (hides subdirs in middle panel)
    let _navigatedFromBookmark = false;

    const _updateFooterButtons = () => {
        if (selectedPath) {
            selectBtn.disabled = false; selectBtn.style.opacity = '1';
            const ext = selectedPath.replace(/\\/g, '/').split('/').pop().split('.').pop().toLowerCase();
            const isImg = ['png','jpg','jpeg','webp'].includes(ext);
            maskEditorBtn.disabled = !isImg;
            maskEditorBtn.style.opacity = isImg ? '1' : '0.5';
        } else {
            selectBtn.disabled = true; selectBtn.style.opacity = '0.5';
            maskEditorBtn.disabled = true; maskEditorBtn.style.opacity = '0.5';
        }
    };

    maskEditorBtn.onclick = () => {
        if (!selectedPath || maskEditorBtn.disabled) return;
        if (window.mpeOpenMaskEditor) {
            window.mpeOpenMaskEditor(selectedPath, () => {
                if (currentPath) navigate(currentPath);
            });
        }
    };

    if (selectedPath) { _updateFooterButtons(); }

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

    // ─── Multi-selection state for image grid ────────────────────────────────
    // selectedPaths is a Set of file paths currently selected in the grid.
    // selectedPath (singular, already declared above) is the "primary" selection
    // shown in the footer; we sync it to the last-clicked item.
    const selectedPaths = new Set();
    let _lastClickedIdx = -1; // index of last single-clicked image for shift-range

    // Helper: update visual state of all imgWrapper elements in the current grid
    const _refreshSelectionVisuals = (imageGridContainer) => {
        if (!imageGridContainer) return;
        for (const wrapper of imageGridContainer.querySelectorAll('[data-img-path]')) {
            const p = wrapper.dataset.imgPath;
            const isSel = selectedPaths.has(p);
            wrapper.style.border = `2px solid ${isSel ? '#4a90d9' : '#3a4a5a'}`;
            wrapper.style.boxShadow = isSel ? '0 0 0 1px #4a90d9 inset' : 'none';
            const cb = wrapper.querySelector('.mpe-sel-cb');
            if (cb) cb.checked = isSel;
        }
        // Update footer label
        if (selectedPaths.size > 1) {
            selectedLabel.textContent = `${selectedPaths.size} images selected`;
        } else if (selectedPaths.size === 1) {
            selectedLabel.textContent = `Selected: ${[...selectedPaths][0]}`;
        }
    };

    const renderDir = (data) => {
        currentBrowseData = data;
        listContainer.innerHTML = '';
        // Clear multi-selection when directory changes
        selectedPaths.clear();
        _lastClickedIdx = -1;

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
        
        // Render directories first — hidden when navigated from a bookmark
        // (subfolders are shown in the left panel instead)
        for (const entry of _navigatedFromBookmark ? [] : filteredOtherFiles.filter(e => e.type === 'dir')) {
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
            row.oncontextmenu = (e) => showContextMenu(e, entry.path, true, getBookmarks, addBookmark, removeBookmark, renderBookmarks, () => navigate(currentPath));
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
                saveUIState({ lastSelectedFile: entry.path });
                _updateFooterButtons();
                renderDir(currentBrowseData);
            };
            row.ondblclick = () => { selectedPath = entry.path; cleanup(); onSelect(selectedPath); };
            row.oncontextmenu = (e) => showContextMenu(e, entry.path, false, getBookmarks, addBookmark, removeBookmark, renderBookmarks, () => navigate(currentPath));
            listContainer.appendChild(row);
        }
        
        // ─── Render images as thumbnails with lazy loading + multi-selection ───
        // DOM wrappers for ALL images are created immediately (so the grid has
        // the correct height/scrollbar), but img.src is only set once a wrapper
        // scrolls into the viewport — the browser never issues a network request
        // for images that are off-screen.
        if (filteredImageFiles.length > 0) {
            const sortMethod = sortSelect.value;
            const sortedImageFiles = sortImages(filteredImageFiles, sortMethod);
            const colsPerRow = parseInt(sizeSlider.value);
            const imageGridContainer = document.createElement('div');
            imageGridContainer.style.cssText = `display:grid;grid-template-columns:repeat(${colsPerRow}, 1fr);gap:10px;padding:10px;`;

            // One shared observer for this render pass; disconnected when the
            // grid is removed from the DOM (i.e. on next navigate / renderDir).
            const lazyObserver = new IntersectionObserver((entries, obs) => {
                for (const oe of entries) {
                    if (!oe.isIntersecting) continue;
                    const wrapper = oe.target;
                    const url = wrapper.dataset.lazyUrl;
                    if (!url) { obs.unobserve(wrapper); continue; }
                    delete wrapper.dataset.lazyUrl; // mark as triggered
                    obs.unobserve(wrapper);

                    const img = wrapper._lazyImg;
                    if (!img) continue;

                    img.src = url;
                    img.onerror = () => {
                        wrapper.innerHTML = '<span style="font-size:40px;color:#7a9ab8;text-align:center;">📄</span>';
                        // Re-append nameLabel which was cleared by innerHTML
                        if (wrapper._nameLabel) wrapper.appendChild(wrapper._nameLabel);
                        if (wrapper._infoOverlay) wrapper.appendChild(wrapper._infoOverlay);
                    };
                    img.onload = () => {
                        const width = img.naturalWidth;
                        const height = img.naturalHeight;
                        if (wrapper._entry) { wrapper._entry.width = width; wrapper._entry.height = height; }
                        if (width && height) {
                            const dimLabel = document.createElement('div');
                            dimLabel.style.cssText = 'position:absolute;top:0;left:0;right:0;background:rgba(0,0,0,0.7);color:#a8dff0;font-size:10px;padding:3px;text-align:center;font-weight:600;font-family:monospace;';
                            dimLabel.textContent = `${width}×${height}`;
                            wrapper.appendChild(dimLabel);
                        }
                    };
                }
            }, {
                root: listContainer,   // observe within the scrollable panel
                rootMargin: '200px',   // start loading 200 px before entering view
                threshold: 0
            });

            // ── Drag ghost element shared across all imgWrappers ──
            let _dragGhost = null;

            for (let imgIdx = 0; imgIdx < sortedImageFiles.length; imgIdx++) {
                const entry = sortedImageFiles[imgIdx];
                const isGridSelected = selectedPaths.has(entry.path);
                const imgWrapper = document.createElement('div');
                imgWrapper.style.cssText = `position:relative;aspect-ratio:1;border:2px solid ${isGridSelected?'#4a90d9':'#3a4a5a'};border-radius:6px;overflow:hidden;cursor:pointer;background:#111820;flex-direction:column;display:flex;align-items:center;justify-content:center;box-shadow:${isGridSelected?'0 0 0 1px #4a90d9 inset':'none'};`;
                imgWrapper.dataset.imgPath = entry.path;
                imgWrapper.dataset.imgIdx = imgIdx;

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

                // ── Selection checkbox (top-left corner) ──
                const cbWrap = document.createElement('label');
                cbWrap.style.cssText = 'position:absolute;top:5px;left:5px;z-index:5;display:flex;align-items:center;justify-content:center;width:18px;height:18px;cursor:pointer;';
                cbWrap.title = 'Select image';
                cbWrap.onclick = (e) => e.stopPropagation(); // prevent bubbling to imgWrapper
                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.className = 'mpe-sel-cb';
                cb.checked = isGridSelected;
                cb.style.cssText = 'width:14px;height:14px;cursor:pointer;accent-color:#4a90d9;';
                cb.onchange = (e) => {
                    e.stopPropagation();
                    if (cb.checked) {
                        selectedPaths.add(entry.path);
                    } else {
                        selectedPaths.delete(entry.path);
                    }
                    _lastClickedIdx = imgIdx;
                    selectedPath = entry.path;
                    _updateFooterButtons();
                    _refreshSelectionVisuals(imageGridContainer);
                };
                cbWrap.appendChild(cb);
                imgWrapper.appendChild(cbWrap);

                // Create img element but do NOT set src yet
                const img = document.createElement('img');
                img.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain;pointer-events:none;';
                imgWrapper.appendChild(img);

                // Filename label
                const nameLabel = document.createElement('div');
                nameLabel.style.cssText = 'position:absolute;bottom:0;left:0;right:0;background:rgba(0,0,0,0.6);color:#c8dff0;font-size:10px;padding:3px 4px;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
                nameLabel.textContent = entry.has_metadata ? '📋 ' + entry.name : entry.name;
                nameLabel.title = entry.name;
                imgWrapper.appendChild(nameLabel);

                // Hover info overlay — reduced dark effect by 70% (0.8 → 0.24)
                const infoOverlay = document.createElement('div');
                infoOverlay.style.cssText = 'position:absolute;inset:0;background:rgba(0,0,0,0.24);color:#a8dff0;font-size:9px;padding:6px;opacity:0;display:flex;align-items:flex-end;justify-content:center;text-align:center;line-height:1.3;transition:opacity 0.2s;pointer-events:none;';
                let infoText = [];
                if (entry.size !== undefined) {
                    infoText.push(entry.size < 1024 ? entry.size + 'B' :
                                  entry.size < 1048576 ? (entry.size/1024).toFixed(1) + 'KB' :
                                  (entry.size/1048576).toFixed(1) + 'MB');
                }
                if (entry.mtime) {
                    infoText.push(new Date(entry.mtime * 1000).toLocaleDateString('en-US', {month:'short', day:'numeric'}));
                }
                infoOverlay.textContent = infoText.join(' • ');
                imgWrapper.appendChild(infoOverlay);

                // Stash references needed by the observer callback
                imgWrapper._lazyImg    = img;
                imgWrapper._entry      = entry;
                imgWrapper._nameLabel  = nameLabel;
                imgWrapper._infoOverlay = infoOverlay;
                imgWrapper.dataset.lazyUrl = previewUrl;

                imgWrapper.onmouseenter = () => { infoOverlay.style.opacity = '1'; };
                imgWrapper.onmouseleave = () => { infoOverlay.style.opacity = '0'; };

                // ── Click handling: simple, Ctrl, Shift ──
                imgWrapper.onclick = (e) => {
                    // Ignore if clicking on the checkbox itself
                    if (e.target === cb || e.target === cbWrap) return;

                    if (e.ctrlKey || e.metaKey) {
                        // Ctrl+click: toggle this image in/out of selection
                        if (selectedPaths.has(entry.path)) {
                            selectedPaths.delete(entry.path);
                        } else {
                            selectedPaths.add(entry.path);
                        }
                        _lastClickedIdx = imgIdx;
                        selectedPath = entry.path;
                    } else if (e.shiftKey && _lastClickedIdx >= 0) {
                        // Shift+click: select range [_lastClickedIdx, imgIdx]
                        const lo = Math.min(_lastClickedIdx, imgIdx);
                        const hi = Math.max(_lastClickedIdx, imgIdx);
                        selectedPaths.clear();
                        for (let i = lo; i <= hi; i++) {
                            selectedPaths.add(sortedImageFiles[i].path);
                        }
                        selectedPath = entry.path;
                    } else {
                        // Plain click: select only this image
                        selectedPaths.clear();
                        selectedPaths.add(entry.path);
                        _lastClickedIdx = imgIdx;
                        selectedPath = entry.path;
                        saveUIState({ lastSelectedFile: entry.path });
                        displayMetadata(entry.path);
                    }
                    _updateFooterButtons();
                    _refreshSelectionVisuals(imageGridContainer);
                };

                imgWrapper.ondblclick = () => { selectedPath = entry.path; saveUIState({ lastSelectedFile: entry.path }); cleanup(); onSelect(selectedPath); };
                imgWrapper.oncontextmenu = (e) => {
                    // If right-clicking an item that isn't yet selected, select it first
                    if (!selectedPaths.has(entry.path)) {
                        selectedPaths.clear();
                        selectedPaths.add(entry.path);
                        selectedPath = entry.path;
                        _lastClickedIdx = imgIdx;
                        _refreshSelectionVisuals(imageGridContainer);
                    }
                    showContextMenu(e, entry.path, false, getBookmarks, addBookmark, removeBookmark, renderBookmarks, () => navigate(currentPath));
                };

                // ── Drag-to-favorite: drag selected image(s) onto a bookmark folder ──
                imgWrapper.draggable = true;
                imgWrapper.addEventListener('dragstart', (e) => {
                    // If the dragged image isn't in the selection, make it the sole selection
                    if (!selectedPaths.has(entry.path)) {
                        selectedPaths.clear();
                        selectedPaths.add(entry.path);
                        selectedPath = entry.path;
                        _lastClickedIdx = imgIdx;
                        _refreshSelectionVisuals(imageGridContainer);
                    }
                    const paths = [...selectedPaths];
                    e.dataTransfer.setData('application/x-mpe-paths', JSON.stringify(paths));
                    e.dataTransfer.effectAllowed = 'move';

                    // Build a custom ghost showing count
                    _dragGhost = document.createElement('div');
                    _dragGhost.style.cssText = 'position:fixed;top:-200px;left:0;background:#2a6ea6;color:#fff;padding:6px 12px;border-radius:6px;font-size:13px;font-family:sans-serif;font-weight:600;pointer-events:none;z-index:99999;';
                    _dragGhost.textContent = paths.length > 1 ? `🖼 Moving ${paths.length} images` : `🖼 Moving ${entry.name}`;
                    document.body.appendChild(_dragGhost);
                    e.dataTransfer.setDragImage(_dragGhost, 0, 0);
                });

                imgWrapper.addEventListener('dragend', () => {
                    if (_dragGhost) { _dragGhost.remove(); _dragGhost = null; }
                });

                imageGridContainer.appendChild(imgWrapper);
                lazyObserver.observe(imgWrapper);
            }

            listContainer.appendChild(imageGridContainer);

            // ── Restore selection + scroll to last-selected image ──────────────
            // If selectedPath is one of the images in this directory, mark it as
            // selected and scroll it into view.  We use requestAnimationFrame so
            // the browser has laid out the grid before we call scrollIntoView.
            if (selectedPath) {
                const matchWrapper = imageGridContainer.querySelector(
                    `[data-img-path="${CSS.escape(selectedPath)}"]`
                );
                if (matchWrapper) {
                    // Pre-populate selection set so checkbox + border are correct
                    selectedPaths.add(selectedPath);
                    _refreshSelectionVisuals(imageGridContainer);
                    // Scroll after the next paint so the element has real dimensions
                    requestAnimationFrame(() => {
                        matchWrapper.scrollIntoView({ block: 'center', behavior: 'smooth' });
                    });
                }
            }

            // Clean up the observer when this grid is replaced by the next renderDir call.
            // We watch for the grid's removal from the DOM using a MutationObserver.
            const cleanupObs = new MutationObserver(() => {
                if (!imageGridContainer.isConnected) {
                    lazyObserver.disconnect();
                    cleanupObs.disconnect();
                }
            });
            cleanupObs.observe(listContainer, { childList: true });
        }
    };


    const navigate = async (path, fromBookmark = false) => {
        _navigatedFromBookmark = fromBookmark;
        setLoading();
        // Clear filter when navigating to a new directory
        searchInput.value = '';
        currentFilter = '';
        searchResultsLabel.textContent = '';
        cachedMetadata = {}; // Clear metadata cache

        // Abort any previous in-flight navigate so stale responses never
        // overwrite a newer navigation that already completed.
        if (navigate._abortCtrl) navigate._abortCtrl.abort();
        const ctrl = new AbortController();
        navigate._abortCtrl = ctrl;

        try {
            const resp = await fetch(`/meta-prompt-extractor/browse?path=${encodeURIComponent(path)}`, { signal: ctrl.signal });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            if (data.error) throw new Error(data.error);

            // If we were superseded by a newer navigate call, silently discard
            if (ctrl.signal.aborted) return;

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
            _scrollToActiveFolder();
            // Remember last browsed directory
            saveUIState({ lastBrowsedPath: currentPath });
        } catch (e) {
            if (e.name === 'AbortError') return; // superseded — ignore silently
            listContainer.innerHTML = `<div style="color:#e07070;font-size:13px;padding:16px;">${e.message}</div>`;
        }
    };
    
    // ─── Subfolder expand state: path → { expanded: bool, subfolders: [{name,path}]|null }
    // `expanded` flags are persisted to uiState.expandedPaths (a plain string[]) so the
    // tree is restored exactly as the user left it when they close and reopen the modal.
    // `subfolders` and `hasChildren` are always re-fetched fresh — never persisted.
    const _persistedExpanded = new Set(
        Array.isArray(_uiState.expandedPaths) ? _uiState.expandedPaths : []
    );
    const _bookmarkExpandState = {};

    // Write the current set of expanded paths back to uiState
    const _saveExpandState = () => {
        const expanded = Object.entries(_bookmarkExpandState)
            .filter(([, s]) => s.expanded)
            .map(([path]) => path);
        saveUIState({ expandedPaths: expanded });
    };

    // Fetch immediate subdirectories of a path (returns array of {name, path} or [])
    // Calls are serialised through a simple queue so that restoring a deep saved tree
    // on open never fires dozens of concurrent /browse requests against the HDD at once.
    const _fetchSubfolders = (() => {
        let _queue = Promise.resolve();
        return (path) => {
            const task = _queue.then(async () => {
                try {
                    const resp = await fetch(`/meta-prompt-extractor/browse?path=${encodeURIComponent(path)}&type=folders`);
                    if (!resp.ok) return [];
                    const data = await resp.json();
                    if (!data.entries) return [];
                    return data.entries
                        .filter(e => e.type === 'dir')
                        .map(e => ({ name: e.name, path: e.path }));
                } catch (e) {
                    return [];
                }
            });
            _queue = task.then(() => {}, () => {}); // keep chain alive even on error
            return task;
        };
    })();

    // Recursively render a folder row (bookmark root or any subfolder) at a given indent depth
    const _renderFolderRow = (container, folderPath, folderName, depth, isBookmarkRoot) => {
        const stateKey = folderPath;
        if (!_bookmarkExpandState[stateKey]) {
            _bookmarkExpandState[stateKey] = {
                expanded:    _persistedExpanded.has(folderPath),
                subfolders:  null,
                hasChildren: null
            };
        }
        const state = _bookmarkExpandState[stateKey];

        const isCurrentPath = folderPath === currentPath;
        const indent = depth * 12; // px indent per level

        // Wrapper for the row + its children
        const wrapper = document.createElement('div');

        // ── Row itself ──
        const row = document.createElement('div');
        row.style.cssText = `display:flex;align-items:center;gap:4px;padding:9px 6px 9px ${8 + indent}px;margin:1px 4px;cursor:pointer;user-select:none;background:${isCurrentPath?'rgba(42,110,166,0.35)':'transparent'};border-radius:4px;border-left:3px solid ${isCurrentPath?'#2a6ea6':'transparent'};transition:background 0.15s;`;
        if (isCurrentPath) row.dataset.activeFolder = '1';

        // Expand arrow placeholder (always reserve space for alignment)
        const arrowBtn = document.createElement('span');
        arrowBtn.style.cssText = 'font-size:14px;color:#7a9ab8;cursor:pointer;flex-shrink:0;width:16px;text-align:center;line-height:1;user-select:none;';
        arrowBtn.textContent = ''; // filled in after we know if there are children
        row.appendChild(arrowBtn);

        const nameSpan = document.createElement('span');
        nameSpan.textContent = folderName;
        nameSpan.style.cssText = `flex:1;font-size:14px;color:${isCurrentPath?'#c8e8ff':'#9ab8d0'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`;
        row.appendChild(nameSpan);

        // Remove button (only on bookmark roots)
        if (isBookmarkRoot) {
            const removeBtn = document.createElement('button');
            removeBtn.textContent = '✕';
            removeBtn.style.cssText = 'background:none;border:none;color:#7a5a5a;cursor:pointer;font-size:11px;padding:2px 4px;border-radius:3px;opacity:0;transition:opacity 0.15s;flex-shrink:0;';
            removeBtn.onclick = (e) => {
                e.stopPropagation();
                removeBookmark(folderPath);
                // Remove this folder and every cached descendant from expand state
                const prefix = folderPath.replace(/\\/g, '/');
                for (const key of Object.keys(_bookmarkExpandState)) {
                    if (key.replace(/\\/g, '/').startsWith(prefix)) {
                        delete _bookmarkExpandState[key];
                    }
                }
                _saveExpandState();
                renderBookmarks();
            };
            row.onmouseenter = () => {
                if (!isCurrentPath) row.style.background = 'rgba(255,255,255,0.06)';
                removeBtn.style.opacity = '1';
                removeBtn.style.color = '#e07070';
            };
            row.onmouseleave = () => {
                if (!isCurrentPath) row.style.background = 'transparent';
                removeBtn.style.opacity = '0';
                removeBtn.style.color = '#7a5a5a';
            };
            row.appendChild(removeBtn);
        } else {
            row.onmouseenter = () => { if (!isCurrentPath) row.style.background = 'rgba(255,255,255,0.06)'; };
            row.onmouseleave = () => { if (!isCurrentPath) row.style.background = 'transparent'; };
        }

        wrapper.appendChild(row);

        // Children container (hidden until expanded)
        const childrenContainer = document.createElement('div');
        childrenContainer.style.cssText = 'display:none;';
        wrapper.appendChild(childrenContainer);

        // ── Populate arrow + children asynchronously ──
        const refreshArrow = () => {
            if (state.hasChildren === false) {
                arrowBtn.textContent = '';
                arrowBtn.style.cursor = 'default';
            } else if (state.hasChildren === true) {
                arrowBtn.textContent = state.expanded ? '▾' : '▸';
                arrowBtn.style.color = '#a8c8e8';
                arrowBtn.style.cursor = 'pointer';
            } else {
                arrowBtn.textContent = ''; // still loading
            }
            childrenContainer.style.display = (state.expanded && state.hasChildren) ? 'block' : 'none';
        };

        const buildChildren = () => {
            childrenContainer.innerHTML = '';
            if (state.subfolders && state.subfolders.length > 0) {
                for (const sub of state.subfolders) {
                    _renderFolderRow(childrenContainer, sub.path, sub.name, depth + 1, false);
                }
            }
        };

        // Kick off async check for children if not cached
        if (state.hasChildren === null) {
            _fetchSubfolders(folderPath).then(subs => {
                state.subfolders = subs;
                state.hasChildren = subs.length > 0;
                refreshArrow();
                if (state.expanded) buildChildren();
            });
        } else {
            refreshArrow();
            if (state.expanded) buildChildren();
        }

        // Arrow click: toggle expand
        arrowBtn.onclick = async (e) => {
            e.stopPropagation();
            if (state.hasChildren === false) return;
            state.expanded = !state.expanded;
            if (state.expanded && state.subfolders === null) {
                const subs = await _fetchSubfolders(folderPath);
                state.subfolders = subs;
                state.hasChildren = subs.length > 0;
            }
            _saveExpandState();
            refreshArrow();
            buildChildren();
        };

        // Row click: navigate to this folder (fromBookmark=true for roots and their children)
        row.onclick = (e) => {
            if (e.target === arrowBtn) return;
            navigate(folderPath, true);
        };

        // ── Drop target: accept dragged images from the grid ──
        row.addEventListener('dragover', (e) => {
            if (e.dataTransfer.types.includes('application/x-mpe-paths')) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                row.style.background = 'rgba(74,144,217,0.35)';
                row.style.borderLeft = '3px solid #4a90d9';
            }
        });
        row.addEventListener('dragleave', (e) => {
            if (!row.contains(e.relatedTarget)) {
                row.style.background = isCurrentPath ? 'rgba(42,110,166,0.35)' : 'transparent';
                row.style.borderLeft = `3px solid ${isCurrentPath ? '#2a6ea6' : 'transparent'}`;
            }
        });
        row.addEventListener('drop', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            row.style.background = isCurrentPath ? 'rgba(42,110,166,0.35)' : 'transparent';
            row.style.borderLeft = `3px solid ${isCurrentPath ? '#2a6ea6' : 'transparent'}`;
            let paths = [];
            try { paths = JSON.parse(e.dataTransfer.getData('application/x-mpe-paths')); } catch {}
            if (!paths.length) return;
            // Move files to this bookmark folder
            try {
                const res = await fetch('/meta-prompt-extractor/move-files', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ source_paths: paths, destination_dir: folderPath })
                });
                const data = await res.json();
                if (data.status === 'ok' || data.status === 'partial') {
                    if (data.errors && data.errors.length > 0) alert('Move errors:\n' + data.errors.join('\n'));
                    // Refresh the middle panel since files have moved away
                    if (currentPath) navigate(currentPath, _navigatedFromBookmark);
                } else { alert('Move failed: ' + (data.message || 'Unknown error')); }
            } catch (err) { alert('Move error: ' + err); }
        });

        container.appendChild(wrapper);
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
            _renderFolderRow(bookmarksList, bookmark.path, bookmark.name, 0, true);
        }
    };

    // Scroll bookmarksList so the active folder row is visible — precisely, with no overshoot.
    //
    // WHY NOT scrollIntoView: it scrolls every scrollable ancestor simultaneously
    // (sidebar, page body…), causing them to fight and overshoot.
    //
    // WHY NOT offsetTop chain walk: bookmarksList is position:static so it never
    // appears in the offsetParent chain — the walk exits at sidebar instead,
    // giving a wrong top value.
    //
    // CORRECT APPROACH: getBoundingClientRect() gives viewport-relative coords for
    // both the element and the container; their difference is the true visible offset
    // regardless of CSS positioning. Combine with scrollTop to get the absolute
    // offset inside the scrollable container, then clamp so the row is fully visible.
    const _scrollSidebarToEl = (el) => {
        const elRect   = el.getBoundingClientRect();
        const listRect = bookmarksList.getBoundingClientRect();
        // Position of el's top edge relative to the top of bookmarksList's content area
        const relTop   = elRect.top - listRect.top + bookmarksList.scrollTop;
        const elH      = el.offsetHeight;
        const listH    = bookmarksList.clientHeight;
        const cur      = bookmarksList.scrollTop;
        const MARGIN   = 8;

        if (relTop - MARGIN < cur) {
            // Row is above visible area — scroll up to show it with a small margin
            bookmarksList.scrollTop = Math.max(0, relTop - MARGIN);
        } else if (relTop + elH + MARGIN > cur + listH) {
            // Row is below visible area — scroll down just enough to show it
            bookmarksList.scrollTop = relTop + elH + MARGIN - listH;
        }
        // Already fully visible — do nothing
    };

    const _scrollToActiveFolder = () => {
        // Immediately check — row may already be in the DOM if tree was cached
        const existing = bookmarksList.querySelector('[data-active-folder]');
        if (existing) {
            _scrollSidebarToEl(existing);
            return;
        }

        // The active row doesn't exist yet — it appears only after async
        // _fetchSubfolders calls resolve level by level down the tree.
        // On large HDD folders (87k files) a single fetch can take >1 s, and
        // a 3-level deep path needs 3 sequential fetches.  We must wait long
        // enough for all of them to complete before giving up.
        // Timeout = 30 s (generous for slow HDDs) — the observer auto-disconnects
        // the moment the row is found, so there is no real cost to being generous.
        let timer = null;
        const obs = new MutationObserver(() => {
            const el = bookmarksList.querySelector('[data-active-folder]');
            if (!el) return;            // not yet — keep watching
            // Found — disconnect FIRST so no further mutations re-trigger this
            obs.disconnect();
            clearTimeout(timer);
            // Defer by one rAF so the browser has finished painting the new rows
            // before we measure their dimensions with getBoundingClientRect()
            requestAnimationFrame(() => _scrollSidebarToEl(el));
        });
        obs.observe(bookmarksList, { childList: true, subtree: true });
        timer = setTimeout(() => obs.disconnect(), 30000);
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
    selectBtn.onclick = () => { if (selectedPath) { saveUIState({ lastSelectedFile: selectedPath }); cleanup(); onSelect(selectedPath); } };
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

    // Start navigation — derive folder from last selected file, then lastBrowsedPath, then caller's currentFile
    let startPath = null;

    if (selectedPath && isAbsolutePath(selectedPath)) {
        // Navigate to the folder containing the last selected file
        const parts = selectedPath.replace(/\\/g, '/').split('/');
        parts.pop();
        startPath = parts.join('/') || '/';
    } else if (_uiState.lastBrowsedPath) {
        startPath = _uiState.lastBrowsedPath;
    } else if (currentFile && isAbsolutePath(currentFile)) {
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

            // Register this node so _mpe_notifyMaskSaved can find it.
            // Use WeakRef if available so GC'd nodes don't accumulate.
            if (typeof WeakRef !== 'undefined') {
                window._mpe_nodeRegistry.add(new WeakRef(node));
            } else {
                window._mpe_nodeRegistry.add(node);
            }

            // ── Ensure both conditioning optional input slots exist ──
            // These slots must be present from the very first frame so the serialiser
            // saves them and ComfyUI can reconnect wires on graph restore.
            const _hasCondInput = node.inputs?.some(inp => inp.name === "conditioning");
            if (!_hasCondInput) {
                node.addInput("conditioning", "CONDITIONING");
            }
            const _hasCondNegInput = node.inputs?.some(inp => inp.name === "conditioning_negative");
            if (!_hasCondNegInput) {
                node.addInput("conditioning_negative", "CONDITIONING");
            }

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

            // ── use_conditioning toggle widget ──────────────────────────────────
            // This boolean widget sits below the two conditioning input slots on
            // the node.  It controls whether conditioning extraction takes priority
            // over file-based extraction at execution time.
            //
            // Auto-behaviour (wired via onConnectionsChange below):
            //   • A conditioning wire is connected  → toggle turns ON automatically
            //   • All conditioning wires removed    → toggle turns OFF automatically
            //   • User manually turns OFF            → stays OFF even if wires present
            // The use_conditioning boolean is supplied by the Python node definition.
            // We do not create a second, redundant toggle here.

            // Helper: check whether any conditioning input has a live link
            const _anyCondConnected = () => {
                return node.inputs?.some(
                    inp => (inp.name === "conditioning" || inp.name === "conditioning_negative")
                           && inp.link != null
                );
            };

            // ── onConnectionsChange — auto-manage the toggle ────────────────────
            const origConnectionsChange = node.onConnectionsChange;
            node.onConnectionsChange = function(type, index, connected, link_info) {
                if (origConnectionsChange) origConnectionsChange.apply(this, arguments);

                const inp = this.inputs?.[index];
                const isCondSlot = inp && (
                    inp.name === "conditioning" || inp.name === "conditioning_negative"
                );
                if (!isCondSlot) return;

                const toggle = this.widgets?.find(w => w.name === "use conditioning" || w.name === "use_conditioning");
                if (!toggle) return;

                if (connected) {
                    // A conditioning wire was just connected — turn the toggle ON
                    toggle.value = true;
                } else {
                    // A wire was removed — turn OFF only if no conditioning remains
                    if (!_anyCondConnected()) {
                        toggle.value = false;
                    }
                }
                this.setDirtyCanvas(true);
            };

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

                // Fix output shape — must match Python RETURN_TYPES/RETURN_NAMES exactly:
                // ("STRING","STRING","IMAGE","MASK","STRING") / ("positive_prompt","negative_prompt","image","mask","path")
                const VALID_OUTPUTS = [
                    { name: "positive_prompt", type: "STRING" },
                    { name: "negative_prompt", type: "STRING" },
                    { name: "image",           type: "IMAGE"  },
                    { name: "mask",            type: "MASK"   },
                    { name: "path",            type: "STRING" },
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
                
                // Remove spurious inputs that ComfyUI may have re-created from serialised data,
                // but preserve both conditioning slots — they are legitimate optional inputs.
                if (this.inputs) {
                    const KEEP_INPUTS = new Set(["conditioning", "conditioning_negative"]);
                    for (let i = this.inputs.length - 1; i >= 0; i--) {
                        if (!KEEP_INPUTS.has(this.inputs[i]?.name)) {
                            this.removeInput(i);
                        }
                    }
                    // Ensure both conditioning slots exist (recreate if missing)
                    if (!this.inputs.some(inp => inp.name === "conditioning")) {
                        this.addInput("conditioning", "CONDITIONING");
                    }
                    if (!this.inputs.some(inp => inp.name === "conditioning_negative")) {
                        this.addInput("conditioning_negative", "CONDITIONING");
                    }
                }

                // ── Ensure use_conditioning toggle widget exists ──────────────────
                const hasToggle = this.widgets?.some(w => w.name === "use conditioning" || w.name === "use_conditioning");
                if (!hasToggle) {
                    const toggleWidget = {
                        name:      "use_conditioning",
                        type:      "toggle",
                        value:     false,
                        serialize: true,
                        options:   { on: "", off: "" },
                        callback:  function(v) { node.setDirtyCanvas(true); },
                    };
                    if (!this.widgets) this.widgets = [];
                    this.widgets.push(toggleWidget);
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
