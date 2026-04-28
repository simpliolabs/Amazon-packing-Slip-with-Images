/**
 * Password Validator — Amazon Credential Management 1.4 Compliance
 *
 * Requirements:
 * - Minimum 12 characters
 * - No user name parts (email local part, full name)
 * - Complexity: upper + lower case + numbers + special characters
 * - All four character classes required
 */

export interface PasswordValidationResult {
  valid: boolean
  errors: string[]
  checks: {
    minLength: boolean
    hasUppercase: boolean
    hasLowercase: boolean
    hasNumber: boolean
    hasSpecial: boolean
    noUsernameParts: boolean
  }
}

const MIN_LENGTH = 12

/**
 * Validate a password against Amazon Credential Management 1.4 requirements.
 * @param password - The password to validate
 * @param email - The user's email address (optional, for username exclusion check)
 * @param fullName - The user's full name (optional, for username exclusion check)
 */
export function validatePassword(
  password: string,
  email?: string | null,
  fullName?: string | null
): PasswordValidationResult {
  const errors: string[] = []

  // 1. Minimum length
  const minLength = password.length >= MIN_LENGTH
  if (!minLength) {
    errors.push(`Password must be at least ${MIN_LENGTH} characters`)
  }

  // 2. Uppercase letter
  const hasUppercase = /[A-Z]/.test(password)
  if (!hasUppercase) {
    errors.push('Password must contain at least one uppercase letter')
  }

  // 3. Lowercase letter
  const hasLowercase = /[a-z]/.test(password)
  if (!hasLowercase) {
    errors.push('Password must contain at least one lowercase letter')
  }

  // 4. Number
  const hasNumber = /[0-9]/.test(password)
  if (!hasNumber) {
    errors.push('Password must contain at least one number')
  }

  // 5. Special character
  const hasSpecial = /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]/.test(password)
  if (!hasSpecial) {
    errors.push('Password must contain at least one special character (!@#$%^&*...)')
  }

  // 6. No username parts (email local part, full name parts)
  let noUsernameParts = true
  const passwordLower = password.toLowerCase()

  if (email) {
    const localPart = email.split('@')[0]?.toLowerCase()
    if (localPart && localPart.length >= 3 && passwordLower.includes(localPart)) {
      noUsernameParts = false
      errors.push('Password must not contain your email username')
    }
  }

  if (fullName) {
    const nameParts = fullName.toLowerCase().split(/\s+/).filter(p => p.length >= 3)
    for (const part of nameParts) {
      if (passwordLower.includes(part)) {
        noUsernameParts = false
        errors.push('Password must not contain parts of your name')
        break
      }
    }
  }

  const checks = {
    minLength,
    hasUppercase,
    hasLowercase,
    hasNumber,
    hasSpecial,
    noUsernameParts,
  }

  return {
    valid: Object.values(checks).every(Boolean),
    errors,
    checks,
  }
}

/**
 * Calculate password strength score (0-5) for UI display.
 */
export function getPasswordStrength(checks: PasswordValidationResult['checks']): {
  score: number
  label: string
  color: string
} {
  const score = Object.values(checks).filter(Boolean).length

  if (score <= 2) return { score, label: 'Weak', color: 'bg-red-500' }
  if (score <= 3) return { score, label: 'Fair', color: 'bg-orange-500' }
  if (score <= 4) return { score, label: 'Good', color: 'bg-yellow-500' }
  if (score <= 5) return { score, label: 'Strong', color: 'bg-green-400' }
  return { score, label: 'Excellent', color: 'bg-green-600' }
}
