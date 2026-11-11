/**
 * Token 消耗审计（纯逻辑，CLI 与测试共用）。
 *
 * 背景：项目按**字符数**记账（见 src/llm.js 的 usage 注释），因为不是所有网关
 * 都返回 token usage；中文大约 1 字 ≈ 0.625 token（即 1.6 字符/Token），
 * 足够看清"钱花在哪一步"的结构。
 *
 * 数据来源有两类：
 *   · **真实任务**：各任务目录里的 meta.json → usage（视觉/总结/精修都合并了）
 *   · **确定性模拟**：用假 LLM 跑一遍流水线，输入字符与真模型完全一致
 *     （输出是假的，但"输入花在哪"的结论不受影响）
 */

/** 中文/混合文本的经验换算：1 Token ≈ 1.6 字符 */
export const CHARS_PER_TOKEN = 1.6;

/** 字符数 → 估算 Token */
export function estimateTokens(chars) {
  const n = Number(chars);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n / CHARS_PER_TOKEN);
}

/** 一组按 step 的汇总 → 排序后的数组（按总字符降序） */
export function breakdownByStep(byStep) {
  return Object.entries(byStep || {})
    .map(([step, s]) => {
      const systemChars = Number(s?.systemChars) || 0;
      const userChars = Number(s?.userChars) || 0;
      const replyChars = Number(s?.replyChars) || 0;
      return {
        step,
        calls: Number(s?.calls) || 0,
        systemChars,
        userChars,
        replyChars,
        totalChars: systemChars + userChars + replyChars,
        ms: Number(s?.ms) || 0,
      };
    })
    .sort((a, b) => b.totalChars - a.totalChars);
}

/**
 * 审计一组真实任务。
 *
 * @param {Array<{id:string, source?:string, meta:object}>} tasks
 * @returns {object}
 */
export function auditTasks(tasks = []) {
  const rows = (Array.isArray(tasks) ? tasks : [])
    .filter(t => t && t.meta && t.meta.usage)
    .map(t => {
      const u = t.meta.usage;
      const inputChars = Number(u.inputChars) || 0;
      const outputChars = Number(u.outputChars) || 0;
      return {
        id: t.id,
        source: t.source || '',
        kind: t.meta.kind || 'generate',
        title: String(t.meta.title || ''),
        model: String(t.meta.model || ''),
        novelChars: Number(t.meta.counts?.chars) || 0,
        calls: Number(u.calls) || 0,
        failedCalls: Number(u.failedCalls) || 0,
        inputChars,
        outputChars,
        totalChars: inputChars + outputChars,
        tokens: estimateTokens(inputChars + outputChars),
        byStep: u.byStep || {},
      };
    });

  const ok = rows.filter(r => r.outputChars > 0);
  const failed = rows.filter(r => r.outputChars === 0);
  const sum = (list, key) => list.reduce((s, r) => s + (Number(r[key]) || 0), 0);

  /** 全量任务里按 step 汇总（只统计有输出的任务，避免失败任务污染结构） */
  const byStep = {};
  for (const r of ok) {
    for (const item of breakdownByStep(r.byStep)) {
      const acc = byStep[item.step] || (byStep[item.step] = {
        calls: 0, systemChars: 0, userChars: 0, replyChars: 0, totalChars: 0,
      });
      acc.calls += item.calls;
      acc.systemChars += item.systemChars;
      acc.userChars += item.userChars;
      acc.replyChars += item.replyChars;
      acc.totalChars += item.totalChars;
    }
  }
  const stepRows = Object.entries(byStep)
    .map(([step, s]) => ({ step, ...s, tokens: estimateTokens(s.totalChars) }))
    .sort((a, b) => b.totalChars - a.totalChars);
  const stepTotal = stepRows.reduce((s, r) => s + r.totalChars, 0) || 1;

  const perNovel = ok.filter(r => r.novelChars > 0);
  const ratios = perNovel.map(r => r.totalChars / r.novelChars).sort((a, b) => a - b);
  const median = ratios.length
    ? ratios[Math.floor((ratios.length - 1) / 2)]
    : null;

  return {
    rows,
    count: rows.length,
    okCount: ok.length,
    failedCount: failed.length,
    failedRate: rows.length ? failed.length / rows.length : 0,
    totals: {
      calls: sum(ok, 'calls'),
      failedCalls: sum(ok, 'failedCalls'),
      inputChars: sum(ok, 'inputChars'),
      outputChars: sum(ok, 'outputChars'),
      totalChars: sum(ok, 'totalChars'),
      tokens: estimateTokens(sum(ok, 'totalChars')),
    },
    /** 失败任务的输入是纯浪费：没有输出，但输入已经发出去了 */
    wasted: {
      tasks: failed.length,
      inputChars: sum(failed, 'inputChars'),
      tokens: estimateTokens(sum(failed, 'inputChars')),
    },
    avgTokensPerTask: ok.length ? estimateTokens(sum(ok, 'totalChars') / ok.length) : 0,
    /** 总字符 / 原文字符：倍数越高说明同一段正文被喂了越多遍 */
    charsPerNovelChar: median == null ? null : Number(median.toFixed(2)),
    byStep: stepRows.map(r => ({ ...r, percent: Number((r.totalChars / stepTotal * 100).toFixed(1)) })),
    top: [...ok].sort((a, b) => b.totalChars - a.totalChars).slice(0, 5),
  };
}

/** 审计结果的文字报告（终端输出用） */
export function formatAuditReport(audit) {
  const a = audit || {};
  const lines = [];
  const n = (v) => Number(v || 0).toLocaleString('en-US');
  lines.push('===== 真实任务 Token 消耗 =====');
  lines.push(`任务 ${a.count || 0} 个：成功 ${a.okCount || 0} / 输出为空 ${a.failedCount || 0}`
    + `（失败率 ${Math.round((a.failedRate || 0) * 100)}%）`);
  if (a.totals) {
    lines.push(`成功任务合计：调用 ${n(a.totals.calls)} 次 / 输入 ${n(a.totals.inputChars)} 字符 / `
      + `输出 ${n(a.totals.outputChars)} 字符 ≈ ${n(a.totals.tokens)} Token`);
    lines.push(`平均每个成功任务 ≈ ${n(a.avgTokensPerTask)} Token`
      + (a.charsPerNovelChar != null ? `；总字符 / 原文字符 ≈ ${a.charsPerNovelChar}×` : ''));
  }
  if (a.wasted && a.wasted.tasks) {
    lines.push(`失败任务浪费：${a.wasted.tasks} 个，白发出 ${n(a.wasted.inputChars)} 字符 ≈ ${n(a.wasted.tokens)} Token`);
  }
  if (a.byStep && a.byStep.length) {
    lines.push('');
    lines.push('按步骤（成功任务合计）：');
    for (const s of a.byStep) {
      lines.push(`  ${s.step.padEnd(14)} calls=${String(s.calls).padStart(4)}  `
        + `sys=${String(n(s.systemChars)).padStart(9)}  user=${String(n(s.userChars)).padStart(10)}  `
        + `reply=${String(n(s.replyChars)).padStart(9)}  ≈${String(n(s.tokens)).padStart(9)} Token  (${s.percent}%)`);
    }
  }
  if (a.top && a.top.length) {
    lines.push('');
    lines.push('最大的任务：');
    for (const t of a.top) {
      lines.push(`  ${t.id}  ${t.totalChars.toLocaleString('en-US')} 字符 ≈ ${n(t.tokens)} Token`
        + `  原文 ${t.novelChars.toLocaleString('en-US')} 字`
        + (t.novelChars ? `（${(t.totalChars / t.novelChars).toFixed(1)}×）` : ''));
    }
  }
  return lines.join('\n');
}
