// Which buses are 60-foot articulated ("accordion") buses. The realtime feed only gives each bus's fleet number (vehicle label),
// so this is Saskatoon Transit's roster: Nova LFS Artic 1005-1007 (2010), 2406-2408 (2024), 2511-2520 (2025), 2618-2621 (2026).
// When the city buys more, add the new range here (fleet numbers start with the delivery year).
const ARTIC = [[1005, 1007], [2406, 2408], [2511, 2520], [2618, 2621]];

const isArtic = (label) => {
  const n = Number(label);
  return Number.isInteger(n) && ARTIC.some(([a, b]) => n >= a && n <= b);
};

module.exports = { isArtic, ARTIC };
