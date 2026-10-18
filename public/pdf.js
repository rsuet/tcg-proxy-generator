// JPEG画像と線だけを描く最小限のPDF生成。外部ライブラリは使わない。
// 座標は mm・用紙の左上原点で受け取り、PDFの pt・左下原点に変換する。

const MM_TO_PT = 72 / 25.4;
const encoder = new TextEncoder();

const num = (value) => String(Number(value.toFixed(3)));

/**
 * @param {object} doc
 * @param {number} doc.pageWidth  用紙の幅 (mm)
 * @param {number} doc.pageHeight 用紙の高さ (mm)
 * @param {{ data: Uint8Array, width: number, height: number }[]} doc.images JPEG画像。同じ画像は1回だけ埋め込まれる
 * @param {{ draws: { image: number, x: number, y: number, width: number, height: number }[],
 *           lines: { x1: number, y1: number, x2: number, y2: number }[] }[]} doc.pages
 * @param {number} [doc.lineWidth] 線の太さ (pt)
 * @returns {Blob}
 */
export function buildPdf({ pageWidth, pageHeight, images, pages, lineWidth = 0.25 }) {
  const chunks = [];
  const offsets = [];
  let position = 0;
  const write = (part) => {
    const bytes = typeof part === 'string' ? encoder.encode(part) : part;
    chunks.push(bytes);
    position += bytes.length;
  };
  const beginObject = (id) => {
    offsets[id] = position;
    write(`${id} 0 obj\n`);
  };
  const writeStream = (id, dictionary, data) => {
    beginObject(id);
    write(`<< ${dictionary} /Length ${data.length} >>\nstream\n`);
    write(data);
    write('\nendstream\nendobj\n');
  };

  // オブジェクト番号: 1=Catalog, 2=Pages, 3〜=画像, その後にページとその描画内容が交互に並ぶ
  const imageId = (index) => 3 + index;
  const pageId = (index) => 3 + images.length + index * 2;
  const contentId = (index) => pageId(index) + 1;
  const objectCount = 3 + images.length + pages.length * 2;

  const width = pageWidth * MM_TO_PT;
  const height = pageHeight * MM_TO_PT;
  const x = (mm) => num(mm * MM_TO_PT);
  const y = (mm) => num(height - mm * MM_TO_PT);

  write('%PDF-1.4\n');
  write(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // バイナリを含むことを示すコメント行

  beginObject(1);
  // PrintScaling /None: 対応するビューアで印刷時に用紙に合わせて縮小されないようにする
  write('<< /Type /Catalog /Pages 2 0 R /ViewerPreferences << /PrintScaling /None >> >>\nendobj\n');
  beginObject(2);
  const kids = pages.map((_, index) => `${pageId(index)} 0 R`).join(' ');
  write(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>\nendobj\n`);

  images.forEach((image, index) => {
    writeStream(
      imageId(index),
      `/Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`,
      image.data,
    );
  });

  pages.forEach((page, index) => {
    const used = [...new Set(page.draws.map((draw) => draw.image))];
    const xObjects = used.map((image) => `/Im${image} ${imageId(image)} 0 R`).join(' ');
    beginObject(pageId(index));
    write(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(width)} ${num(height)}] ` +
        `/Resources << /XObject << ${xObjects} >> >> /Contents ${contentId(index)} 0 R >>\nendobj\n`,
    );

    const ops = page.draws.map(
      (draw) =>
        `q ${num(draw.width * MM_TO_PT)} 0 0 ${num(draw.height * MM_TO_PT)} ${x(draw.x)} ${y(draw.y + draw.height)} cm /Im${draw.image} Do Q`,
    );
    if (page.lines.length) {
      ops.push(`0 G ${num(lineWidth)} w`);
      for (const line of page.lines) ops.push(`${x(line.x1)} ${y(line.y1)} m ${x(line.x2)} ${y(line.y2)} l S`);
    }
    writeStream(contentId(index), '', encoder.encode(ops.join('\n')));
  });

  const xrefPosition = position;
  write(`xref\n0 ${objectCount}\n0000000000 65535 f \n`);
  for (let id = 1; id < objectCount; id++) write(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
  write(`trailer\n<< /Size ${objectCount} /Root 1 0 R >>\nstartxref\n${xrefPosition}\n%%EOF\n`);

  return new Blob(chunks, { type: 'application/pdf' });
}
