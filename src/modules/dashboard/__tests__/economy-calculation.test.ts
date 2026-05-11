import { describe, it, expect } from 'vitest'

/**
 * Test suite for salary economy calculation logic
 *
 * Economy = (planned_hours_until_today - completed_hours) × avg_hourly_rate
 */

describe('Salary Economy Calculation', () => {
  it('should calculate economy correctly when all hours are completed', () => {
    const plannedHours = 35
    const completedHours = 35
    const avgHourlyRate = 6000

    const economy = (plannedHours - completedHours) * avgHourlyRate

    expect(economy).toBe(0)
  })

  it('should calculate economy when some hours are missed', () => {
    const plannedHours = 35
    const completedHours = 20
    const avgHourlyRate = 6000

    const economy = (plannedHours - completedHours) * avgHourlyRate

    expect(economy).toBe(90000)
  })

  it('should handle zero completed hours', () => {
    const plannedHours = 40
    const completedHours = 0
    const avgHourlyRate = 5000

    const economy = (plannedHours - completedHours) * avgHourlyRate

    expect(economy).toBe(200000)
  })

  it('should handle fractional hours correctly', () => {
    const plannedHours = 37.5
    const completedHours = 30.0
    const avgHourlyRate = 6000

    const economy = (plannedHours - completedHours) * avgHourlyRate

    expect(economy).toBe(45000)
  })

  it('should never result in negative economy', () => {
    const plannedHours = 20
    const completedHours = 25 // More hours than planned (shouldn't happen but test edge case)
    const avgHourlyRate = 6000

    const rawEconomy = (plannedHours - completedHours) * avgHourlyRate
    const economy = Math.max(0, rawEconomy)

    expect(economy).toBe(0)
  })
})

describe('Monthly Salary Total Calculation', () => {
  it('should calculate total salary for the month', () => {
    const monthlyTotalHours = 160
    const avgHourlyRate = 6000

    const monthlyTotal = monthlyTotalHours * avgHourlyRate

    expect(monthlyTotal).toBe(960000)
  })

  it('should handle multiple teachers with different rates', () => {
    const teachers = [
      { hours: 40, rate: 5000 },
      { hours: 35, rate: 6000 },
      { hours: 30, rate: 7000 },
    ]

    const total = teachers.reduce((sum, t) => sum + t.hours * t.rate, 0)

    expect(total).toBe(620000)
  })
})
