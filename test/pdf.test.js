import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPdf } from '../public/pdf.js';

const MM_TO_PT = 72 / 25.4;
const fakeJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

async function build() {
  const draw = { image: 0, x: 10, y: 20, width: 63, height: 88 };
  const blob = buildPdf({
    pageWidth: 210,
    pageHeight: 297,
    images: [{ data: fakeJpeg, width: 2, height: 3 }],
    pages: [
      { draws: [draw, { ...draw, x: 73 }], lines: [{ x1: 0, y1: 0, x2: 5, y2: 0 }] },
      { draws: [draw], lines: [] },
    ],
  });
  return Buffer.from(await blob.arrayBuffer()).toString('latin1');
}

test('xref の各オフセットが対応するオブジェクトの先頭を指している', async () => {
  const pdf = await build();
  assert.ok(pdf.startsWith('%PDF-1.4\n'));

  const startxref = Number(pdf.match(/startxref\n(\d+)\n%%EOF\n$/)[1]);
  const xref = pdf.slice(startxref).match(/^xref\n0 (\d+)\n((?:\d{10} \d{5} [fn] \n)+)/);
  assert.ok(xref, 'startxref が xref を指している');
  const entries = xref[2].match(/.{20}/gs);
  assert.equal(entries.length, Number(xref[1]));
  entries.slice(1).forEach((entry, index) => {
    const offset = Number(entry.slice(0, 10));
    assert.ok(pdf.startsWith(`${index + 1} 0 obj\n`, offset), `オブジェクト ${index + 1}`);
  });
  // Catalog, Pages, 画像1つ, (ページ + 描画内容) × 2 に 0 番を加えた数
  assert.match(pdf, /\/Size 8 \/Root 1 0 R/);
});

test('ページ数・用紙サイズ・画像の共有が正しい', async () => {
  const pdf = await build();
  assert.match(pdf, /\/Type \/Pages \/Kids \[4 0 R 6 0 R\] \/Count 2/);
  assert.equal(pdf.match(/\/MediaBox \[0 0 595\.276 841\.89\]/g).length, 2);
  assert.equal(pdf.match(/\/Subtype \/Image/g).length, 1, '同じ画像は1回だけ埋め込む');
  assert.match(pdf, /\/Width 2 \/Height 3 .*\/Filter \/DCTDecode \/Length 4 >>\nstream\n\xff\xd8\xff\xd9\nendstream/);
});

test('カードの位置が左下原点の pt に変換される', async () => {
  const pdf = await build();
  const [, a, , , d, e, f] = pdf.match(/q ([\d.]+) (0) (0) ([\d.]+) ([\d.]+) ([\d.]+) cm \/Im0 Do Q/).map(Number);
  const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 0.001, `${actual} ≈ ${expected}`);
  close(a, 63 * MM_TO_PT);
  close(d, 88 * MM_TO_PT);
  close(e, 10 * MM_TO_PT);
  close(f, (297 - 20 - 88) * MM_TO_PT);
  assert.match(pdf, /0 841\.89 m 14\.173 841\.89 l S/);
});
