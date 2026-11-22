export interface PrintDimensions {
  longestSideMm: number;
  baseThicknessMm: number;
}

export const PRINT_STL_HEADER_SUFFIX = " | mm Z-up";

export function hasPrintStlHeader(data: ArrayBuffer) {
  const header = new TextDecoder().decode(data.slice(0, 80));
  return header.includes(PRINT_STL_HEADER_SUFFIX);
}
