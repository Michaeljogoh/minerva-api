/** Shared eval / smoke goals (§2 demo task suite). */

export const T1_GOAL =
  'For Lakeside Manufacturing, run a month-end health check for March 2026: pull uncategorized bank transactions and fixed-asset additions from the client books portal, propose categories/matches, and flag anything tax-sensitive (Section 179 / bonus depreciation) against the latest IRS guidance. Don’t post or categorize anything without my approval.';

export const T2_GOAL =
  "Check IRS.gov for new revenue procedures about Section 179 or bonus depreciation published in the last 30 days. Cross-reference against Lakeside Manufacturing's 2025 depreciation schedule and tell me if they're affected.";

export const T3_GOAL =
  'Open the bank feed and the books register for Lakeside March 2026, find unmatched items, propose matches, and output a reconciliation exception table. Don’t clear anything without my approval.';

export const T4_GOAL =
  'Chase Lakeside’s missing March receipts: pull recent invoices from the client inbox and Stripe-like payments page, propose QuickBooks-style expense categories in the books portal, and don’t post without approval.';
