function sourceAnalytics(records) {
  const groups = new Map();
  for (const record of records) {
    const label = record.attribution?.sourceLabel?.trim() || record.attribution?.source || "unknown";
    const key = label.toLowerCase();
    if (!groups.has(key)) groups.set(key, { source: label, checkouts: 0, purchases: 0, revenue: 0 });
    const row = groups.get(key);
    row.checkouts++;
    if (record.status === "paid") { row.purchases++; row.revenue += Number(record.amount) || 0; }
  }
  const rows = [...groups.values()].map(row => ({ ...row, conversion: row.purchases / row.checkouts * 100 }))
    .sort((a,b) => b.revenue - a.revenue || b.purchases - a.purchases || a.source.localeCompare(b.source));
  const totals = rows.reduce((sum,row) => ({ checkouts:sum.checkouts+row.checkouts, purchases:sum.purchases+row.purchases, revenue:sum.revenue+row.revenue }), {checkouts:0,purchases:0,revenue:0});
  return { rows, totals: { ...totals, conversion: totals.checkouts ? totals.purchases / totals.checkouts * 100 : 0 } };
}
module.exports = sourceAnalytics;
