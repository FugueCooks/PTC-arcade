import type { Request } from 'express';

/**
 * One implementation of the cross-site mutation check.
 *
 * It lived twice — once in auth-routes, once in account-routes — with the same
 * rule written two different ways. Two copies of a security check drift, and
 * when they disagree the symptom is a request rejected on one router and
 * accepted on the other, which reads as a mystery rather than a rule.
 *
 * The rule itself is unchanged: safe methods pass; an explicitly cross-site
 * fetch is refused; and a request that names an Origin must name the one this
 * deployment serves.
 */
export interface CrossSiteVerdict {
  rejected: boolean;
  /** Why, for the log and the message. Never includes anything secret. */
  reason?: 'sec-fetch-site' | 'origin-mismatch' | 'origin-unparsable';
  seenOrigin?: string;
  expectedOrigin?: string;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function checkCrossSite(request: Request, allowedOrigin?: string): CrossSiteVerdict {
  if (SAFE_METHODS.has(request.method)) return { rejected: false };

  const expectedOrigin = allowedOrigin ?? `${request.protocol}://${request.get('host')}`;
  if (request.get('Sec-Fetch-Site') === 'cross-site') {
    return { rejected: true, reason: 'sec-fetch-site', seenOrigin: request.get('Origin'), expectedOrigin };
  }

  const origin = request.get('Origin');
  if (!origin) return { rejected: false };

  try {
    if (new URL(origin).origin !== expectedOrigin) {
      return { rejected: true, reason: 'origin-mismatch', seenOrigin: origin, expectedOrigin };
    }
  } catch {
    return { rejected: true, reason: 'origin-unparsable', seenOrigin: origin, expectedOrigin };
  }
  return { rejected: false };
}

/**
 * A rejection the person who hit it can act on. "This request was rejected"
 * named neither the rule nor the fix, so the only way to tell a misconfigured
 * PUBLIC_APP_ORIGIN from a genuine cross-site attempt was to read the source.
 *
 * Both values are public: the expected origin is this site's own address, and
 * the origin seen is the browser's own address bar. Neither reveals anything
 * an attacker does not already hold.
 */
export function crossSiteMessage(verdict: CrossSiteVerdict): string {
  if (verdict.reason === 'sec-fetch-site') {
    return 'This request was rejected because the browser reported it as cross-site.';
  }
  if (verdict.reason === 'origin-mismatch') {
    return `This request was rejected: it came from ${verdict.seenOrigin}, but this server expects ${verdict.expectedOrigin}.`
      + ' If that is the wrong address, PUBLIC_APP_ORIGIN is misconfigured.';
  }
  return 'This request was rejected because its origin could not be read.';
}
