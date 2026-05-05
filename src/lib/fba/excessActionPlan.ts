/**
 * FBA Excess Inventory — AI Action Plan Generator
 *
 * Uses GPT to generate a consolidated, specific action plan for each excess FBA item.
 * NOT an echo of Amazon's recommendation — a genuine strategic analysis.
 *
 * Input: excess item data (qty, days of supply, velocity, storage cost, price, category)
 * Output: a clear, actionable plan with urgency, tactic, expected outcome, and escalation path
 */

import OpenAI from 'openai'
import type { InventoryHealthItem } from '@/lib/amazon/catalog'

const openai = new OpenAI()

export interface ExcessActionPlan {
  plan: string          // Full LLM-generated action plan text
  urgency: 'low' | 'medium' | 'high' | 'critical'
  primary_action: 'run_sale' | 'outlet_deal' | 'remove' | 'hold' | 'monitor'
  recheck_days: number  // How many days until re-analysis should run
  model: string         // Which model was used
}

/**
 * Context passed to the LLM for each excess item.
 */
interface ExcessItemContext {
  product_name: string
  asin: string
  sku: string
  // Inventory
  qty_available: number
  excess_qty: number
  days_of_supply: number
  // Velocity
  units_sold_30d: number
  fbm_units_30d: number       // FBM velocity from orders table
  // Financials
  your_price: number
  estimated_monthly_storage_fee: number
  estimated_storage_cost_per_unit: number
  // Amazon's raw data
  amazon_alert: string
  amazon_recommended_action: string
  // Context
  is_reanalysis: boolean      // true if this is a follow-up after an action was taken
  previous_plan?: string      // The previous AI plan (for re-analysis context)
  action_taken?: string       // What action the user took
  days_since_action?: number  // How many days ago the action was taken
  // Outcome data (for re-analysis)
  outcome_qty?: number
  outcome_units_sold_30d?: number
  outcome_days_of_supply?: number
  outcome_excess_qty?: number
}

/**
 * Generate an AI action plan for a single excess inventory item.
 */
export async function generateExcessActionPlan(
  item: ExcessItemContext
): Promise<ExcessActionPlan> {
  const systemPrompt = `You are an expert Amazon FBA inventory strategist with deep knowledge of:
- Amazon's promotional tools (Lightning Deals, 7-Day Deals, Outlet Deals, Coupons)
- FBA storage fee structures and long-term storage fee thresholds (365+ days = $6.90/cubic ft surcharge)
- Inventory health optimization and sell-through rate improvement
- When to promote vs. remove vs. hold inventory

Your job is to generate a CONSOLIDATED, SPECIFIC action plan for an overstocked FBA item.
This is NOT a summary of Amazon's recommendation — it is YOUR strategic analysis.

Rules:
- Be specific: name exact discount percentages, deal types, timelines
- Be honest: if the product is a slow mover, say so and recommend removal
- Consider the math: storage fees vs. discount cost vs. sell-through improvement
- Provide an escalation path: "If X doesn't work in Y days, do Z"
- Keep it under 120 words — concise and actionable
- End with a clear primary action in brackets: [RUN SALE], [OUTLET DEAL], [REMOVE], [HOLD], or [MONITOR]`

  let userPrompt: string

  if (item.is_reanalysis && item.action_taken) {
    // Re-analysis prompt — compare before vs. after
    const actionLabel = {
      ran_sale: 'ran a sale',
      created_outlet_deal: 'created an Outlet Deal',
      removed: 'initiated removal',
      held: 'held without action',
      pending: 'took no action yet',
    }[item.action_taken] || item.action_taken

    userPrompt = `RE-ANALYSIS — ${item.days_since_action || 0} days after action was taken.

Product: "${item.product_name}" (ASIN: ${item.asin})

BEFORE action:
- On-hand: ${item.qty_available} units | Excess: ${item.excess_qty} units | Days of supply: ${item.days_of_supply}
- 30-day velocity: ${item.units_sold_30d} FBA + ${item.fbm_units_30d} FBM units
- Monthly storage fee: $${item.estimated_monthly_storage_fee.toFixed(2)}

Action taken: ${actionLabel}
${item.previous_plan ? `Previous plan: "${item.previous_plan.substring(0, 200)}..."` : ''}

AFTER action (current state):
- On-hand: ${item.outcome_qty ?? 'N/A'} units | Excess: ${item.outcome_excess_qty ?? 'N/A'} units | Days of supply: ${item.outcome_days_of_supply ?? 'N/A'}
- 30-day velocity: ${item.outcome_units_sold_30d ?? 'N/A'} units

Did the action work? Analyze the before/after and give a clear verdict + next step.`
  } else {
    // Initial plan prompt
    const storageFeeRisk = item.estimated_monthly_storage_fee > 0
      ? `Monthly storage cost: $${item.estimated_monthly_storage_fee.toFixed(2)} ($${item.estimated_storage_cost_per_unit.toFixed(2)}/unit)`
      : 'Storage cost data not available'

    const velocityContext = item.units_sold_30d > 0 || item.fbm_units_30d > 0
      ? `30-day velocity: ${item.units_sold_30d} FBA units + ${item.fbm_units_30d} FBM units = ${item.units_sold_30d + item.fbm_units_30d} total`
      : '30-day velocity: 0 units (no recent sales)'

    userPrompt = `Product: "${item.product_name}" (ASIN: ${item.asin})
Price: $${item.your_price.toFixed(2)}
On-hand: ${item.qty_available} units | Excess: ${item.excess_qty} units | Days of supply: ${item.days_of_supply} days
${velocityContext}
${storageFeeRisk}
Amazon's alert: "${item.amazon_alert || 'Excess inventory'}"

Generate a consolidated action plan. Be specific about what to do, when, and what outcome to expect.`
  }

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4.1-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 300,
      temperature: 0.4, // Lower temp = more consistent, strategic output
    })

    const planText = response.choices[0]?.message?.content?.trim() || ''

    // Extract primary action from the plan text
    const primaryAction = extractPrimaryAction(planText)

    // Determine urgency based on days of supply and storage cost
    const urgency = computeUrgency(item)

    // Determine recheck window based on recommended action
    const recheckDays = getRecheckDays(primaryAction, item)

    return {
      plan: planText,
      urgency,
      primary_action: primaryAction,
      recheck_days: recheckDays,
      model: 'gpt-4.1-mini',
    }
  } catch (err) {
    console.error('[ExcessActionPlan] OpenAI error:', err)
    // Fallback to rule-based plan if LLM fails
    return generateFallbackPlan(item)
  }
}

/**
 * Extract the primary action from the LLM's plan text.
 * Looks for the bracketed action at the end: [RUN SALE], [OUTLET DEAL], etc.
 */
function extractPrimaryAction(planText: string): ExcessActionPlan['primary_action'] {
  const text = planText.toUpperCase()
  if (text.includes('[RUN SALE]') || text.includes('[SALE]')) return 'run_sale'
  if (text.includes('[OUTLET DEAL]') || text.includes('[OUTLET]')) return 'outlet_deal'
  if (text.includes('[REMOVE]') || text.includes('[REMOVAL]')) return 'remove'
  if (text.includes('[HOLD]')) return 'hold'
  if (text.includes('[MONITOR]')) return 'monitor'

  // Fallback: infer from text content
  if (text.includes('OUTLET')) return 'outlet_deal'
  if (text.includes('SALE') || text.includes('DISCOUNT') || text.includes('PROMOTION')) return 'run_sale'
  if (text.includes('REMOV')) return 'remove'
  return 'monitor'
}

/**
 * Compute urgency level based on days of supply and storage costs.
 */
function computeUrgency(item: ExcessItemContext): ExcessActionPlan['urgency'] {
  // Critical: long-term storage fee risk (365+ days) or very high storage cost
  if (item.days_of_supply > 300 || item.estimated_monthly_storage_fee > 50) return 'critical'
  // High: 180+ days of supply or significant storage cost
  if (item.days_of_supply > 180 || item.estimated_monthly_storage_fee > 20) return 'high'
  // Medium: 90+ days of supply
  if (item.days_of_supply > 90) return 'medium'
  return 'low'
}

/**
 * Determine how many days until re-analysis should run.
 */
function getRecheckDays(
  action: ExcessActionPlan['primary_action'],
  item: ExcessItemContext
): number {
  switch (action) {
    case 'run_sale':
      return 7   // Check after 7-day sale window
    case 'outlet_deal':
      return 14  // Outlet deals take longer to show results
    case 'remove':
      return 30  // Check removal completion
    case 'hold':
      // If holding, check sooner if storage fees are high
      return item.estimated_monthly_storage_fee > 20 ? 14 : 30
    case 'monitor':
    default:
      return 21
  }
}

/**
 * Fallback rule-based plan if LLM is unavailable.
 */
function generateFallbackPlan(item: ExcessItemContext): ExcessActionPlan {
  const velocity = item.units_sold_30d + item.fbm_units_30d
  let plan: string
  let primaryAction: ExcessActionPlan['primary_action']

  if (item.days_of_supply > 300) {
    plan = `You have ${item.qty_available} units with ${item.days_of_supply} days of supply — long-term storage fees are a serious risk. At current velocity (${velocity} units/30d), this won't clear naturally. Consider removal to avoid fees exceeding product value. [REMOVE]`
    primaryAction = 'remove'
  } else if (item.days_of_supply > 150) {
    plan = `${item.excess_qty} excess units with ${item.days_of_supply} days of supply. Run a 7-day sale at 20-25% off to accelerate sell-through. Monthly storage cost: $${item.estimated_monthly_storage_fee.toFixed(2)}. If sale doesn't move at least ${Math.ceil(item.excess_qty * 0.4)} units, escalate to Outlet Deal. [RUN SALE]`
    primaryAction = 'run_sale'
  } else if (item.days_of_supply > 90) {
    plan = `${item.excess_qty} excess units with ${item.days_of_supply} days of supply. Monitor for 3 weeks — at current velocity this may self-correct. If still excess after 21 days, run a 15% off promotion. [MONITOR]`
    primaryAction = 'monitor'
  } else {
    plan = `Mild excess (${item.excess_qty} units, ${item.days_of_supply} days supply). No immediate action needed — monitor velocity over the next month. [MONITOR]`
    primaryAction = 'monitor'
  }

  return {
    plan,
    urgency: computeUrgency(item),
    primary_action: primaryAction,
    recheck_days: getRecheckDays(primaryAction, item),
    model: 'fallback',
  }
}

/**
 * Build the ExcessItemContext from an InventoryHealthItem and FBM velocity data.
 */
export function buildExcessContext(
  healthItem: InventoryHealthItem,
  fbmUnits30d: number,
  options?: {
    is_reanalysis?: boolean
    previous_plan?: string
    action_taken?: string
    days_since_action?: number
    outcome_qty?: number
    outcome_units_sold_30d?: number
    outcome_days_of_supply?: number
    outcome_excess_qty?: number
  }
): ExcessItemContext {
  return {
    product_name: healthItem.product_name,
    asin: healthItem.asin,
    sku: healthItem.sku,
    qty_available: healthItem.qty_available,
    excess_qty: healthItem.excess_qty,
    days_of_supply: healthItem.days_of_supply,
    units_sold_30d: healthItem.units_sold_last_30_days,
    fbm_units_30d: fbmUnits30d,
    your_price: healthItem.your_price,
    estimated_monthly_storage_fee: healthItem.estimated_monthly_storage_fee,
    estimated_storage_cost_per_unit: healthItem.estimated_storage_cost_per_unit,
    amazon_alert: healthItem.alert,
    amazon_recommended_action: healthItem.recommended_action,
    is_reanalysis: options?.is_reanalysis || false,
    previous_plan: options?.previous_plan,
    action_taken: options?.action_taken,
    days_since_action: options?.days_since_action,
    outcome_qty: options?.outcome_qty,
    outcome_units_sold_30d: options?.outcome_units_sold_30d,
    outcome_days_of_supply: options?.outcome_days_of_supply,
    outcome_excess_qty: options?.outcome_excess_qty,
  }
}
