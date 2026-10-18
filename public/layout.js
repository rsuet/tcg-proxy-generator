// 用紙上のカード配置の計算。単位はすべて mm、原点は用紙の左上。
// プレビュー（SVG）とPDF出力の両方がこの結果を使う。

export const A4 = { width: 210, height: 297 };

const MIN_MARGIN = 5; // カードを並べる領域の外側に最低限残す余白
const MARK_OFFSET = 1.5; // カードの端からトンボの始点までの距離
const MARK_LENGTH = 5; // トンボの長さ（余白が狭い場合は短くする）
const EDGE_RESERVE = 3; // トンボの終点と用紙の端の間に残す距離（プリンタが印刷できない領域）

// カードを隙間なく敷き詰め、用紙の中央に寄せる
export function computeLayout({ cardWidth, cardHeight, scale }, page = A4) {
  const width = (cardWidth * scale) / 100;
  const height = (cardHeight * scale) / 100;
  const cols = Math.floor((page.width - MIN_MARGIN * 2) / width);
  const rows = Math.floor((page.height - MIN_MARGIN * 2) / height);
  if (!(cols >= 1 && rows >= 1 && Number.isFinite(cols * rows))) return null;
  return {
    page,
    cardWidth: width,
    cardHeight: height,
    cols,
    rows,
    perPage: cols * rows,
    left: (page.width - cols * width) / 2,
    top: (page.height - rows * height) / 2,
  };
}

// 1ページ内の各カードの左上座標（左上から行優先）
export function cardSlots({ cols, rows, left, top, cardWidth, cardHeight }) {
  const slots = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      slots.push({ x: left + col * cardWidth, y: top + row * cardHeight });
    }
  }
  return slots;
}

// カードの境界線の延長上、余白部分に引くトンボ（線分の配列）
export function trimMarks({ cols, rows, left, top, cardWidth, cardHeight }) {
  const right = left + cols * cardWidth;
  const bottom = top + rows * cardHeight;
  const vertical = Math.min(MARK_LENGTH, top - MARK_OFFSET - EDGE_RESERVE);
  const horizontal = Math.min(MARK_LENGTH, left - MARK_OFFSET - EDGE_RESERVE);
  const lines = [];

  if (vertical >= 1) {
    for (let col = 0; col <= cols; col++) {
      const x = left + col * cardWidth;
      lines.push(
        { x1: x, y1: top - MARK_OFFSET - vertical, x2: x, y2: top - MARK_OFFSET },
        { x1: x, y1: bottom + MARK_OFFSET, x2: x, y2: bottom + MARK_OFFSET + vertical },
      );
    }
  }
  if (horizontal >= 1) {
    for (let row = 0; row <= rows; row++) {
      const y = top + row * cardHeight;
      lines.push(
        { x1: left - MARK_OFFSET - horizontal, y1: y, x2: left - MARK_OFFSET, y2: y },
        { x1: right + MARK_OFFSET, y1: y, x2: right + MARK_OFFSET + horizontal, y2: y },
      );
    }
  }
  return lines;
}

export function paginate(list, perPage) {
  const pages = [];
  for (let i = 0; i < list.length; i += perPage) pages.push(list.slice(i, i + perPage));
  return pages;
}
