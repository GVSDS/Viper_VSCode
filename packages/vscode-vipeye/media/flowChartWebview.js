/*
 * flowChartWebview.js
 *
 * 「函数流程图」面板的 Webview 侧脚本。
 *
 * 以 <script src> 外部文件加载（不用内联脚本 + nonce），避免 CSP 对内联脚本的限制；
 * 图数据由扩展通过 postMessage 下发：{ type: 'render', payload }，payload 为 null 表示空态。
 *
 * 功能：
 *   - 拖拽平移（确认拖动后锁定指针，可无限拖，类似 Blender 的 Continuous Grab）、滚轮缩放
 *   - 点击节点跳转到源码行（postMessage { type: 'jump' }）
 *   - 导出 PNG（导出的重渲染用 htmlLabels:false：<foreignObject> 在 <img> 光栅化时不会被绘制）
 *
 * 注意：该文件是纯 JS 资源（不经 TypeScript 编译），由 rspack 拷到 dist/media 后由 Webview 加载。
 */
(function () {
    // Webview 里没有全局 `vscode`，必须通过 acquireVsCodeApi() 拿通信句柄（每个文档只能调用一次）。
    const vscodeApi = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : undefined;

    const chartElement = document.getElementById('chart');
    const innerElement = document.getElementById('chart-inner');
    const emptyElement = document.getElementById('empty');
    const titleElement = document.getElementById('title');
    const hintElement = document.getElementById('hint');
    const errorElement = document.getElementById('error');
    const zoomLabelElement = document.getElementById('zoom-label');
    const exportPanelElement = document.getElementById('export-panel');
    const estimateElement = document.getElementById('exp-estimate');
    const exportRunButton = document.getElementById('btn-export-run');

    /** 当前图数据（含 mermaidText/nodeLines/functionName/行范围）。 */
    let payload;
    /** 当前缩放与平移。 */
    let zoom = 1;
    let panX = 0;
    let panY = 0;
    /** 当前渲染出的 svg 根元素。 */
    let svgElement;

    let renderSeq = 0;
    let lastTheme = '';
    /** 本次拖拽是否真的移动过（移动过就不触发节点跳转）。 */
    let dragMoved = false;
    /** 是否正在拖拽（用于兜底释放「拖拽结束后才异步生效」的指针锁定）。 */
    let dragging = false;
    /** 导出中标记，避免重复触发。 */
    let exporting = false;

    function isDarkTheme() {
        const className = document.body.className || '';
        if (className.indexOf('vscode-high-contrast') >= 0) {
            return className.indexOf('vscode-high-contrast-light') < 0;
        }
        return className.indexOf('vscode-light') < 0;
    }

    function mermaidTheme() {
        return isDarkTheme() ? 'dark' : 'default';
    }

    function showEmpty() {
        innerElement.innerHTML = '';
        svgElement = undefined;
        titleElement.textContent = '';
        hintElement.style.display = 'none';
        errorElement.style.display = 'none';
        emptyElement.style.display = '';
        updateEstimate();
    }

    function showError(text) {
        innerElement.innerHTML = '';
        svgElement = undefined;
        hintElement.style.display = 'none';
        emptyElement.style.display = 'none';
        errorElement.style.display = 'block';
        errorElement.textContent = text;
    }

    // ===== 平移 / 缩放 =====

    function applyTransform() {
        clampPan();
        innerElement.style.transform = 'translate(' + panX + 'px, ' + panY + 'px) scale(' + zoom + ')';
        if (zoomLabelElement) {
            zoomLabelElement.textContent = Math.round(zoom * 100) + '%';
        }
    }

    /**
     * 限制平移范围：不管怎么拖，视口内至少保留一小块图（默认 80px），
     * 避免把图整个拖出可视区后「什么都没有、也不知道往哪拖回来」。
     */
    function clampPan() {
        if (!svgElement) {
            return;
        }

        const size = getSvgSize(svgElement);
        const chartWidth = size.width * zoom;
        const chartHeight = size.height * zoom;
        const keepVisible = 80;

        const minPanX = -Math.max(0, chartWidth - keepVisible);
        const maxPanX = Math.max(0, chartElement.clientWidth - keepVisible);
        const minPanY = -Math.max(0, chartHeight - keepVisible);
        const maxPanY = Math.max(0, chartElement.clientHeight - keepVisible);

        panX = Math.min(maxPanX, Math.max(minPanX, panX));
        panY = Math.min(maxPanY, Math.max(minPanY, panY));
    }

    /** 取 svg 的自然尺寸（优先 width/height 属性，退化为 bbox）。 */
    function getSvgSize(svgEl) {
        const attrWidth = parseFloat(svgEl.getAttribute('width'));
        const attrHeight = parseFloat(svgEl.getAttribute('height'));
        if (attrWidth > 0 && attrHeight > 0) {
            return { width: attrWidth, height: attrHeight };
        }

        try {
            const box = svgEl.getBBox();
            if (box.width > 0 && box.height > 0) {
                return { width: box.width, height: box.height };
            }
        } catch (e) {
            // 忽略
        }

        return { width: 800, height: 600 };
    }

    function fitToWidth() {
        if (!svgElement) {
            return;
        }

        const size = getSvgSize(svgElement);
        const available = Math.max(80, chartElement.clientWidth - 20);
        zoom = Math.max(0.1, Math.min(4, available / size.width));
        panX = 10;
        panY = 10;
        applyTransform();
    }

    function resetView() {
        zoom = 1;
        panX = 10;
        panY = 10;
        applyTransform();
    }

    function zoomBy(factor) {
        const newZoom = Math.max(0.1, Math.min(8, zoom * factor));
        const ratio = newZoom / zoom;
        const px = chartElement.clientWidth / 2;
        const py = chartElement.clientHeight / 2;
        panX = px - (px - panX) * ratio;
        panY = py - (py - panY) * ratio;
        zoom = newZoom;
        applyTransform();
    }

    chartElement.addEventListener('mousedown', function (event) {
        if (event.button !== 0) {
            return;
        }

        dragMoved = false;
        dragging = true;
        const startX = event.clientX;
        const startY = event.clientY;
        const startPanX = panX;
        const startPanY = panY;
        let locked = false;
        // 锁定生效后重新基准化：只累加 movement 增量，避免与锁定前的坐标体系混用。
        let lockedBasePanX = 0;
        let lockedBasePanY = 0;
        let lockedDeltaX = 0;
        let lockedDeltaY = 0;
        // 锁定的生效是异步的，浏览器会先用一次较大的 movement 与真实光标对齐，需丢弃这一次。
        let skipFirstLockedMove = false;

        function onMove(moveEvent) {
            // 指针锁定后光标不再受面板边界限制，用 movementX/Y 累加平移量（无限拖动）。
            if (document.pointerLockElement === chartElement) {
                const moveX = moveEvent.movementX || 0;
                const moveY = moveEvent.movementY || 0;

                // 丢弃「对齐用的第一次位移」以及明显异常的尖峰，否则图会瞬间跳走。
                if (skipFirstLockedMove || Math.abs(moveX) > 300 || Math.abs(moveY) > 300) {
                    skipFirstLockedMove = false;
                    return;
                }

                lockedDeltaX += moveX;
                lockedDeltaY += moveY;
                dragMoved = true;
                panX = lockedBasePanX + lockedDeltaX;
                panY = lockedBasePanY + lockedDeltaY;
                applyTransform();
                return;
            }

            const dx = moveEvent.clientX - startX;
            const dy = moveEvent.clientY - startY;

            // 先按位移确认「确实是拖动」，确认后才锁指针并开始平移：
            //   - 单击（未移动）不锁指针，节点点击跳转仍然可用；
            //   - 小于阈值的抖动也不会平移，避免「快速连点」时图被一点点推走。
            if (!locked && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
                locked = true;
                dragMoved = true;
                try {
                    const request = chartElement.requestPointerLock && chartElement.requestPointerLock();
                    // 新版 Chrome 返回 Promise，被拒绝时忽略（退化为普通拖拽）。
                    if (request && typeof request.catch === 'function') {
                        request.catch(function () {});
                    }
                } catch (e) {
                    // 忽略
                }
            }

            if (dragMoved) {
                panX = startPanX + dx;
                panY = startPanY + dy;
                applyTransform();
            }
        }

        function onPointerLockChange() {
            if (document.pointerLockElement === chartElement) {
                // 锁定生效：以当前平移量为基准，之后只累加 movement 增量。
                lockedBasePanX = panX;
                lockedBasePanY = panY;
                lockedDeltaX = 0;
                lockedDeltaY = 0;
                skipFirstLockedMove = true;
                return;
            }

            if (locked) {
                // 用户按 Esc 解除锁定时结束本次拖拽，避免坐标跳变。
                onUp();
            }
        }

        function onUp() {
            dragging = false;
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            document.removeEventListener('pointerlockchange', onPointerLockChange);
            if (document.pointerLockElement === chartElement) {
                document.exitPointerLock();
            }
            chartElement.style.cursor = 'grab';
        }

        chartElement.style.cursor = 'grabbing';
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        document.addEventListener('pointerlockchange', onPointerLockChange);
        event.preventDefault();
    });

    // 兜底：指针锁定的生效是异步的。若锁定在拖拽结束后才真正生效，光标会被一直锁住
    // （看不到光标、也无法正常操作），这里检测到就立刻释放。
    document.addEventListener('pointerlockchange', function () {
        if (document.pointerLockElement === chartElement && !dragging) {
            document.exitPointerLock();
        }
    });

    chartElement.addEventListener(
        'wheel',
        function (event) {
            if (!svgElement) {
                return;
            }
            event.preventDefault();

            const rect = chartElement.getBoundingClientRect();
            const px = event.clientX - rect.left;
            const py = event.clientY - rect.top;
            const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
            const newZoom = Math.max(0.1, Math.min(8, zoom * factor));
            const ratio = newZoom / zoom;

            panX = px - (px - panX) * ratio;
            panY = py - (py - panY) * ratio;
            zoom = newZoom;
            applyTransform();
        },
        { passive: false }
    );

    // ===== 渲染 =====

    function resolveNodeId(element, data) {
        const dataId = element.getAttribute('data-id');
        if (dataId && data.nodeLines[dataId]) {
            return dataId;
        }

        const stripped = (element.id || '').replace(/^flowchart-/, '').replace(/-\d+$/, '');
        if (data.nodeLines[stripped]) {
            return stripped;
        }

        const elementId = element.id || '';
        const keys = Object.keys(data.nodeLines);
        for (let i = 0; i < keys.length; i++) {
            if (elementId.indexOf('-' + keys[i] + '-') >= 0) {
                return keys[i];
            }
        }
        return undefined;
    }

    function attachJumpHandlers(data) {
        const nodeElements = chartElement.querySelectorAll('g.node');
        nodeElements.forEach(function (element) {
            const nodeId = resolveNodeId(element, data);
            const line = nodeId ? data.nodeLines[nodeId] : undefined;
            if (!line) {
                return;
            }

            element.style.cursor = 'pointer';
            element.addEventListener('click', function () {
                if (dragMoved || !vscodeApi) {
                    return;
                }
                vscodeApi.postMessage({ type: 'jump', line: line });
            });
        });
    }

    async function render(data) {
        const seq = ++renderSeq;

        if (typeof mermaid === 'undefined') {
            showError('未能加载 mermaid（dist/media/mermaid.min.js）。请确认已 npm install 并重新构建扩展。');
            return;
        }

        lastTheme = mermaidTheme();

        mermaid.initialize({
            startOnLoad: false,
            securityLevel: 'strict',
            theme: lastTheme,
            // useMaxWidth=false：svg 保持自然尺寸，缩放/平移/导出都按像素精确计算。
            flowchart: { useMaxWidth: false, htmlLabels: true },
        });

        try {
            const result = await mermaid.render('viperFlowChart' + seq, data.mermaidText);
            if (seq !== renderSeq) {
                return;
            }

            innerElement.innerHTML = result.svg;
            svgElement = innerElement.querySelector('svg');
            if (svgElement) {
                svgElement.style.maxWidth = 'none';
            }

            emptyElement.style.display = 'none';
            errorElement.style.display = 'none';
            hintElement.style.display = '';
            titleElement.textContent =
                data.functionName + '（第 ' + data.startLine + '-' + data.endLine + ' 行）';

            attachJumpHandlers(data);
            fitToWidth();
            updateEstimate();
        } catch (err) {
            if (seq !== renderSeq) {
                return;
            }
            showError('Mermaid 渲染失败：' + (err && err.message ? err.message : String(err)));
        }
    }

    // ===== 导出 PNG =====

    /** 读取导出设置（倍率 / 宽高 / 裁剪 / 背景）。 */
    function readExportOptions() {
        return {
            scaleFactor: parseFloat(document.getElementById('exp-scale').value) || 1,
            width: document.getElementById('exp-width').value.trim(),
            height: document.getElementById('exp-height').value.trim(),
            crop: document.getElementById('exp-crop').checked,
            whiteBackground: document.getElementById('exp-bg-white').checked,
        };
    }

    /** 按设置与内容尺寸算出输出像素尺寸（导出与「预计尺寸」共用，保证两者一致）。 */
    function computeOutputSize(options, viewBox) {
        let outWidth = options.width ? parseFloat(options.width) : viewBox.width * options.scaleFactor;
        let outHeight = options.height ? parseFloat(options.height) : viewBox.height * options.scaleFactor;
        if (options.width && !options.height) {
            outHeight = outWidth * (viewBox.height / viewBox.width);
        } else if (!options.width && options.height) {
            outWidth = outHeight * (viewBox.width / viewBox.height);
        }
        return { width: Math.max(1, Math.round(outWidth)), height: Math.max(1, Math.round(outHeight)) };
    }

    /** 用当前渲染出的 svg 估算导出尺寸（≈ 实际值，导出时会用 htmlLabels:false 重渲染）。 */
    function updateEstimate() {
        if (!estimateElement) {
            return;
        }

        if (!svgElement) {
            estimateElement.textContent = '预计导出尺寸：—';
            return;
        }

        const options = readExportOptions();
        const natural = getSvgSize(svgElement);
        let content = natural;
        try {
            const box = svgElement.getBBox();
            if (box.width > 0 && box.height > 0) {
                content = { width: box.width, height: box.height };
            }
        } catch (e) {
            // 忽略
        }

        const padding = 8;
        const viewBox = options.crop
            ? { width: content.width + padding * 2, height: content.height + padding * 2 }
            : { width: natural.width, height: natural.height };
        const size = computeOutputSize(options, viewBox);

        estimateElement.textContent = '预计导出尺寸：≈ ' + size.width + ' × ' + size.height + ' px';
    }

    function svgToImage(svgText) {
        return new Promise(function (resolve, reject) {
            const image = new Image();
            // data: URL 不会污染 canvas，且不需要放宽 img-src（CSP 已允许 data:）。
            image.onload = function () {
                resolve(image);
            };
            image.onerror = function () {
                reject(new Error('SVG 转图片失败'));
            };
            image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgText);
        });
    }

    async function exportPng() {
        if (!payload || exporting) {
            return;
        }

        const options = readExportOptions();
        exporting = true;
        if (exportRunButton) {
            exportRunButton.disabled = true;
            exportRunButton.textContent = '导出中…';
        }

        try {
            // 导出的重渲染关闭 htmlLabels：<foreignObject> 里的 HTML 标签在 <img> 光栅化时不会绘制。
            mermaid.initialize({
                startOnLoad: false,
                securityLevel: 'strict',
                theme: mermaidTheme(),
                flowchart: { useMaxWidth: false, htmlLabels: false },
            });

            const result = await mermaid.render('viperFlowChartExport' + ++renderSeq, payload.mermaidText);

            // 离屏测量：只有放进 DOM 才能 getBBox。
            const holder = document.createElement('div');
            holder.style.cssText = 'position: absolute; left: -100000px; top: 0;';
            holder.innerHTML = result.svg;
            document.body.appendChild(holder);

            try {
                const svgEl = holder.querySelector('svg');
                if (!svgEl) {
                    throw new Error('导出用的 SVG 生成失败');
                }

                const natural = getSvgSize(svgEl);

                let contentBox;
                try {
                    const box = svgEl.getBBox();
                    contentBox = { x: box.x, y: box.y, width: box.width, height: box.height };
                } catch (e) {
                    contentBox = { x: 0, y: 0, width: natural.width, height: natural.height };
                }
                if (!(contentBox.width > 0) || !(contentBox.height > 0)) {
                    contentBox = { x: 0, y: 0, width: natural.width, height: natural.height };
                }

                // 裁剪：按内容盒子（留 8px 边距）；不裁剪：按 svg 自身尺寸。
                const padding = 8;
                const viewBox = options.crop
                    ? {
                          x: contentBox.x - padding,
                          y: contentBox.y - padding,
                          width: contentBox.width + padding * 2,
                          height: contentBox.height + padding * 2,
                      }
                    : { x: 0, y: 0, width: natural.width, height: natural.height };

                const size = computeOutputSize(options, viewBox);

                svgEl.setAttribute('viewBox', viewBox.x + ' ' + viewBox.y + ' ' + viewBox.width + ' ' + viewBox.height);
                svgEl.setAttribute('width', String(size.width));
                svgEl.setAttribute('height', String(size.height));
                svgEl.removeAttribute('style');
                svgEl.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
                svgEl.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');

                if (options.whiteBackground) {
                    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
                    rect.setAttribute('x', String(viewBox.x));
                    rect.setAttribute('y', String(viewBox.y));
                    rect.setAttribute('width', String(viewBox.width));
                    rect.setAttribute('height', String(viewBox.height));
                    rect.setAttribute('fill', '#ffffff');
                    svgEl.insertBefore(rect, svgEl.firstChild);
                }

                const svgText = new XMLSerializer().serializeToString(svgEl);
                const image = await svgToImage(svgText);

                const canvas = document.createElement('canvas');
                canvas.width = size.width;
                canvas.height = size.height;
                const context = canvas.getContext('2d');
                context.drawImage(image, 0, 0, size.width, size.height);

                if (vscodeApi) {
                    vscodeApi.postMessage({
                        type: 'exportPng',
                        dataUrl: canvas.toDataURL('image/png'),
                        suggestedName: payload.functionName + '.png',
                    });
                }
            } finally {
                holder.remove();
            }
        } catch (err) {
            showError('导出 PNG 失败：' + (err && err.message ? err.message : String(err)));
        } finally {
            exporting = false;
            if (exportRunButton) {
                exportRunButton.disabled = false;
                exportRunButton.textContent = '导出文件…';
            }
        }
    }

    // ===== 事件绑定 =====

    function bindClick(id, handler) {
        const element = document.getElementById(id);
        if (element) {
            element.addEventListener('click', handler);
        }
    }

    function toggleExportPanel(show) {
        if (!exportPanelElement) {
            return;
        }
        exportPanelElement.style.display = show ? '' : 'none';
        if (show) {
            updateEstimate();
        }
    }

    bindClick('btn-zoom-in', function () {
        zoomBy(1.2);
    });
    bindClick('btn-zoom-out', function () {
        zoomBy(1 / 1.2);
    });
    bindClick('btn-reset', resetView);
    bindClick('btn-fit', fitToWidth);
    bindClick('btn-export-toggle', function () {
        toggleExportPanel(exportPanelElement && exportPanelElement.style.display === 'none');
    });
    bindClick('btn-export-close', function () {
        toggleExportPanel(false);
    });
    bindClick('btn-export-run', function () {
        void exportPng();
    });

    ['exp-scale', 'exp-width', 'exp-height'].forEach(function (id) {
        const element = document.getElementById(id);
        if (element) {
            element.addEventListener('input', updateEstimate);
            element.addEventListener('change', updateEstimate);
        }
    });
    ['exp-crop', 'exp-bg-transparent', 'exp-bg-white'].forEach(function (id) {
        const element = document.getElementById(id);
        if (element) {
            element.addEventListener('change', updateEstimate);
        }
    });

    // 数据由扩展下发；payload 为 null 时显示空态提示。
    window.addEventListener('message', function (event) {
        const message = event.data;
        if (!message || message.type !== 'render') {
            return;
        }

        if (!message.payload) {
            payload = undefined;
            showEmpty();
            return;
        }

        payload = message.payload;
        void render(payload);
    });

    // 主题切换（跟随 VS Code）时重画，否则图会停在旧主题色上。
    new MutationObserver(function () {
        if (payload && mermaidTheme() !== lastTheme) {
            void render(payload);
        }
    }).observe(document.body, { attributes: true, attributeFilter: ['class'] });

    // 告诉扩展「脚本已就绪」，扩展收到后再下发数据（避免消息早于脚本加载而丢失）。
    if (vscodeApi) {
        vscodeApi.postMessage({ type: 'ready' });
    }
})();
