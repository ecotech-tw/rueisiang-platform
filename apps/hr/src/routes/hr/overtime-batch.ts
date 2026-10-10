/**
 * 待審加班裡可以一次核准的批次：同一個批次鍵、而且還有兩筆以上待審。
 * 只剩一筆時逐筆審核就好，不必再多一個入口。
 */
export function reviewableOvertimeBatches<T extends { request: { batchId: string | null } }>(items: readonly T[]) {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    if (!item.request.batchId) continue;
    const group = groups.get(item.request.batchId);
    if (group) group.push(item);
    else groups.set(item.request.batchId, [item]);
  }
  return [...groups.entries()].filter(([, group]) => group.length > 1).map(([batchId, group]) => ({ batchId, items: group }));
}

/**
 * 整批核准確認框要列的內容。確認框開著的時候清單可能重抓（送出被擋下、別人先審掉幾筆），
 * 所以內容一律取最新的待審：只剩一筆也照列，審核者看到的才是按下去會核准的東西。
 * 一筆都不剩時沿用開啟時的內容並標成 settled——整批已經處理完，不能再送。
 */
export function batchDialogItems<T extends { request: { batchId: string | null } }>(pending: readonly T[], opened: { batchId: string; items: T[] }) {
  const live = pending.filter((item) => item.request.batchId === opened.batchId);
  return live.length ? { items: live, settled: false } : { items: opened.items, settled: true };
}
