# deploy/

Commands and facts. Each script's header documents its own options; each step
here calls a script rather than repeating it. Everything runs from the
repository root on the owner's Mac unless a step says otherwise.

Set these in the terminal first; every command below uses them, and the
scripts stop with a usage line when one is empty:

```
IP=<the server's IPv4 address>     # from the Hetzner console
ADMIN=<the admin user's name>      # chosen at first provision
KEY=~/.ssh/vitrina_hetzner
```

They last as long as the terminal window: set them again in a new one.

Every script that logs in needs the SSH key in the agent first:
`ssh-add --apple-use-keychain $KEY`. Before running any script under
`vitrina-server/` on the server, copy the current `deploy/server/` there:
`deploy/server/push.sh $IP $ADMIN`.

---

## 1. Disaster recovery

For when the server is lost and the buckets and the password manager are not.
The media bucket holds the photos; the backup bucket holds the database; the
password manager holds the server secret and the age key that decrypts the
backups. Nothing else is needed.

### 1a. Recovery

1. **Server.** Hetzner console, production project: Ubuntu 24.04, the media
   bucket's location, the SSH key, public IPv4 and IPv6, **Backups off**, no
   volumes, firewalls, placement group, labels or cloud config. Note `IP`.
2. **DNS.** Point the A and AAAA records of the app and API hostnames at the
   new server (IPv6: the `::1` of its `/64`). Check:
   `dig +short <app-hostname> A` and `AAAA`, for both names.
3. **Provision** (first run as root; it asks for the admin's sudo password):
   ```
   scp -i $KEY -r deploy/server root@$IP:/root/vitrina-server
   ssh -t -i $KEY root@$IP bash /root/vitrina-server/provision.sh $ADMIN
   deploy/server/check.sh $IP $ADMIN --violate
   ```
   then push, run it again as the admin (this removes root's key), reboot,
   and check:
   ```
   deploy/server/push.sh $IP $ADMIN
   ssh -t -i $KEY $ADMIN@$IP sudo bash vitrina-server/provision.sh $ADMIN
   ssh -t -i $KEY $ADMIN@$IP sudo reboot
   deploy/server/check.sh $IP $ADMIN
   ```
4. **Configure**, restoring the server secret from the password manager. Storage
   values: the production media bucket's. `--allow`: the owners' addresses.
   ```
   ssh -t -i $KEY $ADMIN@$IP sudo bash vitrina-server/configure.sh --restore-secret --allow <addresses>
   deploy/server/check-config.sh $IP $ADMIN
   ```
5. **Database**, before any deploy. Put the age key file and the backup bucket's
   values on the Mac (§4), then:
   ```
   AGE_IDENTITY=~/vitrina-backup.agekey deploy/backup/recover.sh $IP $ADMIN
   ```
6. **Release.** Its migrations must report `0 applied`.
   ```
   deploy/release/deploy.sh $IP $ADMIN
   deploy/release/verify.sh $IP $ADMIN
   ```
7. **Backups** (bucket values, the `age1…` public key, retention, heartbeat URL),
   then prove them:
   ```
   deploy/server/push.sh $IP $ADMIN
   ssh -t -i $KEY $ADMIN@$IP sudo bash vitrina-server/backup-setup.sh
   pnpm infra:up && pnpm infra:wait
   AGE_IDENTITY=~/vitrina-backup.agekey deploy/backup/restore-test.sh $IP $ADMIN
   ```
8. **Owners' walk**, on a phone: sign in, open an album, open a photo; open an
   existing invite on another device.
9. **Clean up the Mac:** delete `~/vitrina-backup.agekey` and
   `~/.vitrina/backup-bucket.env`; `ssh-keygen -R <old IPv4>` if the old server's
   address is in `known_hosts`. The uptime monitor and the heartbeat resume on
   their own (same hostname; next nightly backup).

### 1b. Rehearsal on a throwaway server

The same recovery, run against copies, so that nothing production is written:

- temporary hostnames, as two **new** DNS records — the app and API records are
  never edited;
- a separate, empty rehearsal media bucket, in a **separate Hetzner project**,
  filled by copying from production: production's media bucket is only listed
  and read (`copy-media.mjs`), its backup bucket only read (`recover.sh`);
- no backups set up on the rehearsal server, so the production backup bucket
  and the heartbeat are never written.

Steps:

1. **Names.** Pick two temporary hostnames under the domain, e.g. `dr-app.` and
   `dr-api.` In this shell, for every step below:
   ```
   export VITRINA_APP_HOST=<temporary app hostname> VITRINA_API_HOST=<temporary API hostname>
   ```
2. **Hetzner:** a new project for the rehearsal, with
   - a server as in 1a step 1 (any location);
   - an empty, private bucket, and S3 credentials for it.
   Put that bucket's values in `~/.vitrina/rehearsal-storage.env`
   (names: `deploy/storage/storage.env.example`, `chmod 600`).
3. **DNS:** add A and AAAA records for the two temporary names only, pointing at
   the rehearsal server. Check with `dig`.
4. **Provision**, as 1a step 3, but with the names on the first run:
   ```
   scp -i $KEY -r deploy/server root@$IP:/root/vitrina-server
   ssh -t -i $KEY root@$IP bash /root/vitrina-server/provision.sh $ADMIN --app-host $VITRINA_APP_HOST --api-host $VITRINA_API_HOST
   deploy/server/check.sh $IP $ADMIN --violate
   ```
   then `push.sh`, provision again as the admin, reboot, `check.sh` — as 1a.
5. **Photos:** copy production's media into the rehearsal bucket.
   ```
   node deploy/backup/copy-media.mjs ~/.vitrina/storage.env ~/.vitrina/rehearsal-storage.env
   ```
6. **Configure** as 1a step 4, with `--restore-secret` and `--allow`, but the
   storage values of the **rehearsal** bucket. Then `check-config.sh`.
7. **Database, release, checks:** 1a steps 5 and 6, unchanged (`deploy.sh`,
   `verify.sh` and `public-check.mjs` use the exported names).
8. **Proof:** at `https://$VITRINA_APP_HOST`, sign in with an owner's real
   password — it works only if the server secret was restored — and see the
   albums and photos. Make a new invite there and open it on another device.
   (Invites made in production point at production and are not used here.)
9. **Teardown:**
   - Hetzner: delete the rehearsal server, its bucket and credentials, and the
     rehearsal project;
   - DNS: delete the two temporary records;
   - Mac: delete `~/.vitrina/rehearsal-storage.env`, `~/.vitrina/backup-bucket.env`
     and `~/vitrina-backup.agekey`; `ssh-keygen -R $IP`; `unset VITRINA_APP_HOST VITRINA_API_HOST`;
   - password manager: delete the rehearsal sudo password.

---

## 2. First deployment

From nothing, with no backup to restore.

1. **Storage acceptance** (brief §12), self-test first, then the real bucket:
   ```
   pnpm infra:up && pnpm infra:wait && pnpm --filter @vitrina/server build
   ACCEPTANCE_SELF_TEST=1 node --env-file=.env.example deploy/storage/acceptance.mjs   # the misspelled-bucket test must fail
   node --env-file=$HOME/.vitrina/storage.env deploy/storage/acceptance.mjs
   ```
2. **Node checksums**, once per Node version: `deploy/server/pin-node.sh`, commit
   `deploy/server/node.sha256`.
3. **Server and DNS:** 1a steps 1 and 2.
4. **Provision:** 1a step 3.
5. **Configure** — generates the server secret, shows it once, writes nothing
   until it is pasted back from the password manager:
   ```
   ssh -t -i $KEY $ADMIN@$IP sudo bash vitrina-server/configure.sh --allow <addresses>
   deploy/server/check-config.sh $IP $ADMIN
   ```
6. **Release:** `deploy/release/deploy.sh $IP $ADMIN`, then
   `deploy/release/verify.sh $IP $ADMIN`.
7. **Backups:** a new age key (`age-keygen -o ~/vitrina-backup.agekey`, the whole
   file to the password manager; `age-keygen -y` gives the public key), a backup
   bucket in a separate project and location, then 1a step 7.
8. **Monitoring:** §4's monitor and heartbeat. Prove both by violation: stop the
   API (`sudo systemctl stop vitrina-api`) until the alert arrives, start it;
   shorten the heartbeat's period until it alerts, restore it.

---

## 3. Day-to-day

**Deploy a release** — from a clean, committed tree:
```
deploy/release/deploy.sh $IP $ADMIN
deploy/release/verify.sh $IP $ADMIN        # optional; restarts the API four times
```

**Add an address to the allowlist** — the list is rewritten whole, so give every
address, old and new:
```
deploy/server/push.sh $IP $ADMIN
ssh -t -i $KEY $ADMIN@$IP sudo bash vitrina-server/configure.sh --allow <every address, comma-separated>
deploy/server/check-config.sh $IP $ADMIN
```

**Rerun the restore test** — recreate `~/vitrina-backup.agekey` from the password
manager first, delete it after:
```
pnpm infra:up && pnpm infra:wait && pnpm --filter @vitrina/server build
AGE_IDENTITY=~/vitrina-backup.agekey deploy/backup/restore-test.sh $IP $ADMIN
```

---

## 4. Outside the repository

Names only. Values live where each line says.

**Hetzner**
- production project: the server (CAX11, Arm64, Ubuntu 24.04), the media bucket,
  the media bucket's S3 credentials. Server backups and snapshots: **off**;
- backups project, in another location: the backup bucket and its S3 credentials.

**DNS** — the domain's zone: A and AAAA records for the app and API hostnames.

**Better Stack**
- uptime monitor: `GET https://<API hostname>/health`, keyword `ok`; never `HEAD`;
- heartbeat: period 1 day, grace 2 hours, pinged by the nightly backup.
- Both URLs carry tokens: secrets, in the password manager and (heartbeat) in
  the server's `backup.env` only.

**Password manager entries**
- Vitrina server secret
- Vitrina backup key (age) — the whole key file
- media bucket: endpoint, region, bucket, access key, secret key
- backup bucket: endpoint, region, bucket, access key, secret key
- admin user's sudo password
- SSH key passphrase
- Better Stack heartbeat URL
- accounts: Hetzner, DNS provider, Better Stack

**On the server, written by scripts, root-only**
- `/etc/vitrina/site.env` — the two hostnames (provision.sh)
- `/etc/vitrina/api.env` — origin, database URL, server secret, media bucket (configure.sh)
- `/etc/vitrina/signup.env` — the allowlist (configure.sh)
- `/etc/vitrina/backup.env` — backup bucket, age public key, retention, heartbeat URL (backup-setup.sh)

**On the Mac, outside the repository**
- `~/.ssh/vitrina_hetzner`, `.pub`
- `~/.vitrina/storage.env` — the media bucket's values
- during a recovery only: `~/.vitrina/backup-bucket.env`
  (names: `deploy/backup/backup-bucket.env.example`), `~/vitrina-backup.agekey`
- during a rehearsal only: `~/.vitrina/rehearsal-storage.env`

**Schedule**
- nightly backup: 03:15 UTC (+ up to 10 min); retention and minimum kept: in `backup.env`
- automatic security updates daily; reboots when needed at 04:00 UTC
- journald keeps 14 days
