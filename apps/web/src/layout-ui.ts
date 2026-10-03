/** 並排時每個對話窗格的最小寬度（畫素，P1-15 / M-29）；再窄就改成分頁。 */
export const MIN_PANE_WIDTH = 360;

/** 對話區的佈局：寬度夠就並排，否則分頁（一次看一個）。寬度還沒量出來（0）時按並排處理。 */
export function paneLayout(width: number, count: number): 'side-by-side' | 'tabs' {
  if (count <= 1 || width <= 0) return 'side-by-side';
  return width / count < MIN_PANE_WIDTH ? 'tabs' : 'side-by-side';
}
