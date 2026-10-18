import assert from 'node:assert/strict';
import { test } from 'node:test';
import { A4, cardSlots, computeLayout, paginate, trimMarks } from '../public/layout.js';

const standard = { cardWidth: 63, cardHeight: 88, scale: 100 };

test('63×88mmのカードはA4に3×3枚、用紙の中央に並ぶ', () => {
  const layout = computeLayout(standard);
  assert.equal(layout.cols, 3);
  assert.equal(layout.rows, 3);
  assert.equal(layout.perPage, 9);
  assert.equal(layout.left, 10.5);
  assert.equal(layout.top, 16.5);
});

test('倍率がカードの大きさに反映される', () => {
  const layout = computeLayout({ ...standard, scale: 102 });
  assert.ok(Math.abs(layout.cardWidth - 64.26) < 1e-9);
  assert.ok(Math.abs(layout.cardHeight - 89.76) < 1e-9);
  assert.equal(layout.perPage, 9);
});

test('A4に1枚も収まらないサイズは null になる', () => {
  assert.equal(computeLayout({ cardWidth: 250, cardHeight: 88, scale: 100 }), null);
});

test('カードは左上から行優先で隙間なく並ぶ', () => {
  const slots = cardSlots(computeLayout(standard));
  assert.equal(slots.length, 9);
  assert.deepEqual(slots[0], { x: 10.5, y: 16.5 });
  assert.deepEqual(slots[1], { x: 73.5, y: 16.5 });
  assert.deepEqual(slots[3], { x: 10.5, y: 104.5 });
});

test('トンボは列と行の境界ごとに上下左右の余白へ引かれる', () => {
  const layout = computeLayout(standard);
  const lines = trimMarks(layout);
  assert.equal(lines.length, (layout.cols + 1) * 2 + (layout.rows + 1) * 2);

  const right = layout.left + layout.cols * layout.cardWidth;
  const bottom = layout.top + layout.rows * layout.cardHeight;
  for (const { x1, y1, x2, y2 } of lines) {
    for (const [x, y] of [[x1, y1], [x2, y2]]) {
      assert.ok(x >= 0 && x <= A4.width && y >= 0 && y <= A4.height, '用紙の内側');
      const insideCards = x > layout.left && x < right && y > layout.top && y < bottom;
      assert.ok(!insideCards, 'カードに重ならない');
    }
  }
  const columnEdges = new Set(lines.filter((line) => line.x1 === line.x2).map((line) => line.x1));
  assert.deepEqual([...columnEdges], [10.5, 73.5, 136.5, 199.5]);
});

test('paginate は1ページの枚数ごとに区切る', () => {
  const pages = paginate(Array.from({ length: 20 }, (_, i) => i), 9);
  assert.deepEqual(pages.map((page) => page.length), [9, 9, 2]);
  assert.equal(pages[2][1], 19);
});
