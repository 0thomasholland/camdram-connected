function loadImage(src) {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = reject;
        image.src = src;
    });
}

async function loadBrandMark() {
    const response = await fetch('/assets/icons/camdram-connected.svg');
    if (!response.ok) throw new Error('Failed to load brand mark');
    const svg = await response.text();
    return loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
}

function roundRect(context, x, y, width, height, radius) {
    context.beginPath();
    context.moveTo(x + radius, y);
    context.lineTo(x + width - radius, y);
    context.quadraticCurveTo(x + width, y, x + width, y + radius);
    context.lineTo(x + width, y + height - radius);
    context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    context.lineTo(x + radius, y + height);
    context.quadraticCurveTo(x, y + height, x, y + height - radius);
    context.lineTo(x, y + radius);
    context.quadraticCurveTo(x, y, x + radius, y);
    context.closePath();
}

function getExportTheme() {
    const styles = getComputedStyle(document.documentElement);
    return {
        bg: styles.getPropertyValue('--bg').trim() || '#f8eede',
        surface: styles.getPropertyValue('--surface').trim() || '#ffffff',
        border: styles.getPropertyValue('--border').trim() || 'rgba(58, 57, 58, 0.2)',
        text: styles.getPropertyValue('--text').trim() || '#3a393a',
        textMuted: styles.getPropertyValue('--text-muted').trim() || 'rgba(58, 57, 58, 0.7)',
        accent: styles.getPropertyValue('--accent').trim() || '#ec6736',
        accentGlow: styles.getPropertyValue('--accent-glow').trim() || 'rgba(236, 103, 54, 0.1)',
    };
}

function fitText(context, text, maxWidth, initialSize, minSize) {
    let size = initialSize;
    while (size > minSize) {
        context.font = `600 ${size}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
        if (context.measureText(text).width <= maxWidth) return size;
        size -= 2;
    }
    return minSize;
}

export async function exportGraphImage(graphContainer) {
    const graphCanvas = graphContainer.querySelector('canvas');
    if (!graphCanvas) return;

    const brandMark = await loadBrandMark();
    const theme = getExportTheme();
    const scale = graphCanvas.clientWidth ? graphCanvas.width / graphCanvas.clientWidth : 1;
    const padding = Math.round(28 * scale);
    const headerHeight = Math.round(108 * scale);
    const footerHeight = Math.round(82 * scale);
    const cardRadius = Math.round(18 * scale);
    const width = graphCanvas.width + padding * 2;
    const height = headerHeight + graphCanvas.height + footerHeight + padding * 2;
    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = width;
    exportCanvas.height = height;

    const context = exportCanvas.getContext('2d');
    context.fillStyle = theme.bg;
    context.fillRect(0, 0, width, height);

    const cardX = padding;
    const cardY = headerHeight;
    const cardWidth = graphCanvas.width;
    const cardHeight = graphCanvas.height;

    roundRect(context, cardX, cardY, cardWidth, cardHeight, cardRadius);
    context.fillStyle = theme.surface;
    context.fill();
    context.lineWidth = Math.max(2, scale);
    context.strokeStyle = theme.border;
    context.stroke();
    context.save();
    roundRect(context, cardX, cardY, cardWidth, cardHeight, cardRadius);
    context.clip();
    context.drawImage(graphCanvas, cardX, cardY, cardWidth, cardHeight);
    context.restore();

    const logoSize = Math.round(44 * scale);
    const logoX = padding;
    const logoY = Math.round(24 * scale);
    context.drawImage(brandMark, logoX, logoY, logoSize, logoSize);

    context.fillStyle = theme.text;
    context.font = `700 ${Math.round(28 * scale)}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
    context.textBaseline = 'alphabetic';
    context.fillText('Camdram Connected', logoX + logoSize + Math.round(16 * scale), logoY + Math.round(18 * scale));

    context.fillStyle = theme.textMuted;
    context.font = `500 ${Math.round(14 * scale)}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
    context.fillText('Find connection between any two people in Cambridge theatre', logoX + logoSize + Math.round(16 * scale), logoY + Math.round(42 * scale));

    const exportUrl = window.location.href;
    const footerY = headerHeight + graphCanvas.height + Math.round(24 * scale);
    const urlBoxX = padding;
    const urlBoxY = footerY - Math.round(6 * scale);
    const urlBoxWidth = width - padding * 2;
    const urlBoxHeight = Math.round(42 * scale);

    roundRect(context, urlBoxX, urlBoxY, urlBoxWidth, urlBoxHeight, Math.round(21 * scale));
    context.fillStyle = theme.accentGlow;
    context.fill();
    context.strokeStyle = theme.border;
    context.stroke();

    context.fillStyle = theme.accent;
    context.font = `700 ${Math.round(14 * scale)}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
    context.fillText('URL', urlBoxX + Math.round(16 * scale), urlBoxY + Math.round(27 * scale));

    const urlTextX = urlBoxX + Math.round(60 * scale);
    const urlFontSize = fitText(context, exportUrl, urlBoxWidth - Math.round(76 * scale), Math.round(14 * scale), Math.round(10 * scale));
    context.font = `600 ${urlFontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
    context.fillStyle = theme.textMuted;
    context.fillText(exportUrl, urlTextX, urlBoxY + Math.round(27 * scale));

    const link = document.createElement('a');
    link.download = 'camdram-connected.png';
    link.href = exportCanvas.toDataURL('image/png');
    link.click();
}
