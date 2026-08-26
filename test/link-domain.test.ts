import assert from 'node:assert/strict';
import test from 'node:test';
import { importBrowserModule } from './helpers/browser-module.js';

/**
 * The DNS change itself cannot be rehearsed — it happens once, against a live
 * zone, from a runner. So the part that decides what to touch is pure and
 * tested here, with the zone as it actually stood before the cutover.
 */
const { desiredRecords, planDnsChanges } = await importBrowserModule<any>('tools/link-domain.mjs');

const DOMAIN = 'ptcarcade.fun';
const FLY = { ipv4: '66.241.125.10', ipv6: '2a09:8280:1::a:b' };

/** The zone as measured on 2026-08-26: proxied apex, no www, no mail. */
const currentZone = [
  { id: 'a1', type: 'A', name: DOMAIN, content: '104.21.20.102', proxied: true, ttl: 1 },
  { id: 'a2', type: 'A', name: DOMAIN, content: '172.67.192.84', proxied: true, ttl: 1 },
  { id: 'aaaa1', type: 'AAAA', name: DOMAIN, content: '2606:4700:3032::6815:1466', proxied: true, ttl: 1 }
];

void test('the apex is repointed at Fly and taken out of the proxy', () => {
  const plan = planDnsChanges(currentZone, desiredRecords(DOMAIN, FLY));

  const apexA = plan.update.find((change: any) => change.after.type === 'A');
  assert.ok(apexA, 'the existing A record must be updated, not duplicated');
  assert.equal(apexA.after.content, FLY.ipv4);
  assert.equal(apexA.after.proxied, false, 'proxied, Fly can never issue a certificate');

  // The second apex A record has to go, or the domain round-robins between the
  // new host and the old one and looks intermittently broken.
  assert.ok(plan.delete.some((record: any) => record.id === 'a2'), 'the duplicate apex A must be removed');
  assert.ok(plan.create.some((record: any) => record.type === 'CNAME' && record.name === `www.${DOMAIN}`));
});

void test('records the cutover does not own are never touched', () => {
  // Deleting a mail record while repointing a website is not recoverable, and
  // the operator would not find out until someone failed to receive an email.
  const withMail = [
    ...currentZone,
    { id: 'mx1', type: 'MX', name: DOMAIN, content: 'mail.example.com', priority: 10 },
    { id: 'txt1', type: 'TXT', name: DOMAIN, content: 'v=spf1 include:example.com ~all' },
    { id: 'txt2', type: 'TXT', name: `_dmarc.${DOMAIN}`, content: 'v=DMARC1; p=none' },
    { id: 'sub', type: 'A', name: `staging.${DOMAIN}`, content: '203.0.113.9', proxied: false }
  ];
  const plan = planDnsChanges(withMail, desiredRecords(DOMAIN, FLY));
  const touched = [...plan.delete, ...plan.update.map((change: any) => change.before)].map((record: any) => record.id);
  for (const untouchable of ['mx1', 'txt1', 'txt2', 'sub']) {
    assert.ok(!touched.includes(untouchable), `${untouchable} must be left alone`);
  }
});

void test('an apex CNAME is removed, since it cannot coexist with A records', () => {
  const zone = [{ id: 'c1', type: 'CNAME', name: DOMAIN, content: 'old-host.example.com', proxied: true }];
  const plan = planDnsChanges(zone, desiredRecords(DOMAIN, FLY));
  assert.ok(plan.delete.some((record: any) => record.id === 'c1'));
});

void test('re-running after a successful cutover changes nothing', () => {
  const settled = [
    { id: 'a1', type: 'A', name: DOMAIN, content: FLY.ipv4, proxied: false, ttl: 1 },
    { id: 'aaaa1', type: 'AAAA', name: DOMAIN, content: FLY.ipv6, proxied: false, ttl: 1 },
    { id: 'w1', type: 'CNAME', name: `www.${DOMAIN}`, content: DOMAIN, proxied: false, ttl: 1 }
  ];
  const plan = planDnsChanges(settled, desiredRecords(DOMAIN, FLY));
  assert.deepEqual([plan.create.length, plan.update.length, plan.delete.length], [0, 0, 0]);
  assert.equal(plan.unchanged.length, 3);
});

void test('a record that is right but still proxied is corrected', () => {
  // The likeliest half-finished state: the operator repointed the address by
  // hand and left the orange cloud on.
  const halfDone = [{ id: 'a1', type: 'A', name: DOMAIN, content: FLY.ipv4, proxied: true, ttl: 1 }];
  const plan = planDnsChanges(halfDone, desiredRecords(DOMAIN, { ipv4: FLY.ipv4 }));
  assert.equal(plan.update.length, 1);
  assert.equal(plan.update[0].after.proxied, false);
});

void test('a missing address family contributes no record rather than a broken one', () => {
  const ipv4Only = desiredRecords(DOMAIN, { ipv4: FLY.ipv4 });
  assert.ok(!ipv4Only.some((record: any) => record.type === 'AAAA'), 'an unallocated IPv6 must not become an empty record');
  assert.ok(ipv4Only.some((record: any) => record.type === 'CNAME'));
});
