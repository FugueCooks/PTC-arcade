/**
 * Points a Cloudflare-hosted zone at this app's Fly addresses.
 *
 * The zone for ptcarcade.fun is delegated to Cloudflare (the registrar is only
 * the registrar), and its apex currently answers with Cloudflare's own anycast
 * addresses — a proxied record in front of the previous host. Both facts are
 * easy to get wrong by hand, and getting them wrong produces a redirect loop or
 * a 526 that reads like an application fault, so the change is scripted.
 *
 * Records are written DNS-only on purpose. Proxied, Cloudflare terminates TLS
 * itself and answers the ACME challenge, so Fly can never issue a certificate.
 *
 * Usage (see .github/workflows/link-domain.yml, which is how this normally runs):
 *   CLOUDFLARE_API_TOKEN=... node tools/link-domain.mjs \
 *     --domain ptcarcade.fun --ipv4 1.2.3.4 --ipv6 2a09:... [--dry-run]
 *
 * The token needs Zone → DNS → Edit on this zone, and nothing else.
 */

const API = 'https://api.cloudflare.com/client/v4';

function parseArguments(argv) {
  const options = { dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--dry-run') options.dryRun = true;
    else if (flag === '--domain') options.domain = argv[++index];
    else if (flag === '--ipv4') options.ipv4 = argv[++index];
    else if (flag === '--ipv6') options.ipv6 = argv[++index];
  }
  return options;
}

/**
 * The records this domain should have, given the app's addresses. An address
 * that was not allocated simply contributes no record rather than a broken one.
 */
export function desiredRecords(domain, { ipv4, ipv6 }) {
  const records = [];
  if (ipv4) records.push({ type: 'A', name: domain, content: ipv4, proxied: false, ttl: 1 });
  if (ipv6) records.push({ type: 'AAAA', name: domain, content: ipv6, proxied: false, ttl: 1 });
  records.push({ type: 'CNAME', name: `www.${domain}`, content: domain, proxied: false, ttl: 1 });
  return records;
}

/**
 * Works out the minimum set of edits, and — this is the part that matters —
 * scopes deletion to the exact names and types being replaced. MX, TXT, and
 * anything else in the zone is never touched: taking out a mail record while
 * repointing a website is not a recoverable mistake.
 */
export function planDnsChanges(existing, desired) {
  const plan = { create: [], update: [], delete: [], unchanged: [] };
  const claimed = new Set();

  for (const target of desired) {
    const matches = existing.filter((record) => record.type === target.type && record.name === target.name);
    const [first, ...duplicates] = matches;
    for (const duplicate of duplicates) {
      // A second A record at the apex would round-robin between the new host
      // and the old one, which looks like an intermittent outage.
      plan.delete.push(duplicate);
      claimed.add(duplicate.id);
    }
    if (!first) {
      plan.create.push(target);
      continue;
    }
    claimed.add(first.id);
    const sameContent = first.content === target.content;
    const sameProxy = Boolean(first.proxied) === target.proxied;
    if (sameContent && sameProxy) plan.unchanged.push(target);
    else plan.update.push({ id: first.id, before: first, after: target });
  }

  // A leftover record of a type being replaced still answers for the same name.
  const replacedNames = new Set(desired.map((record) => `${record.type} ${record.name}`));
  for (const record of existing) {
    if (claimed.has(record.id)) continue;
    if (replacedNames.has(`${record.type} ${record.name}`)) plan.delete.push(record);
  }

  // The apex cannot hold a CNAME alongside A/AAAA records.
  if (desired.some((record) => record.type === 'A' || record.type === 'AAAA')) {
    const apex = desired[0].name;
    for (const record of existing) {
      if (record.type === 'CNAME' && record.name === apex && !claimed.has(record.id)) plan.delete.push(record);
    }
  }
  return plan;
}

async function call(token, pathname, init = {}) {
  const response = await fetch(`${API}${pathname}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {}) }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success === false) {
    const detail = (payload.errors ?? []).map((error) => `${error.code} ${error.message}`).join('; ');
    throw new Error(`Cloudflare ${init.method ?? 'GET'} ${pathname} failed (${response.status}): ${detail || 'no detail'}`);
  }
  return payload.result;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
  if (!token) throw new Error('Set CLOUDFLARE_API_TOKEN (Zone → DNS → Edit on this zone).');
  if (!options.domain) throw new Error('Pass --domain.');
  if (!options.ipv4 && !options.ipv6) throw new Error('Pass at least one of --ipv4 or --ipv6.');

  const [zone] = await call(token, `/zones?name=${encodeURIComponent(options.domain)}`);
  if (!zone) throw new Error(`No Cloudflare zone named ${options.domain} is visible to this token.`);
  console.log(`zone ${zone.name} (${zone.id})`);

  const existing = await call(token, `/zones/${zone.id}/dns_records?per_page=200`);
  const desired = desiredRecords(options.domain, options);
  const plan = planDnsChanges(existing, desired);

  for (const record of plan.unchanged) console.log(`  = ${record.type} ${record.name} -> ${record.content}`);
  for (const record of plan.create) console.log(`  + ${record.type} ${record.name} -> ${record.content} (DNS only)`);
  for (const change of plan.update) {
    console.log(`  ~ ${change.after.type} ${change.after.name}: ${change.before.content}`
      + `${change.before.proxied ? ' (proxied)' : ''} -> ${change.after.content} (DNS only)`);
  }
  for (const record of plan.delete) console.log(`  - ${record.type} ${record.name} -> ${record.content}`);

  if (options.dryRun) {
    console.log('dry run: nothing was changed');
    return;
  }

  // Delete last: the zone never goes through a window with no address record.
  for (const record of plan.create) {
    await call(token, `/zones/${zone.id}/dns_records`, { method: 'POST', body: JSON.stringify(record) });
  }
  for (const change of plan.update) {
    await call(token, `/zones/${zone.id}/dns_records/${change.id}`, { method: 'PATCH', body: JSON.stringify(change.after) });
  }
  for (const record of plan.delete) {
    await call(token, `/zones/${zone.id}/dns_records/${record.id}`, { method: 'DELETE' });
  }
  console.log(`applied: ${plan.create.length} created, ${plan.update.length} updated, ${plan.delete.length} deleted`);
}

// Importable for tests; only the direct invocation touches the network.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  await main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
