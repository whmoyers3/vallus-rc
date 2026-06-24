export function ventilationCfmForBedrooms(bedrooms: number) {
  return 15 * (Math.max(0, Math.floor(bedrooms)) + 1);
}
