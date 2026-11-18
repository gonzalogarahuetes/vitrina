# deploy/

Commands and facts. Each script's header documents its own options; each step
here calls a script rather than repeating it. Everything runs from the
repository root on the owner's Mac unless a step says otherwise.

Set these in the terminal first; every command below uses them, and the
scripts stop with a usage line when one is empty:

```
IP=<the server's IPv4 address>     # from the Hetzner console
ADMIN=<the admin user's name>      # chosen at first provision; password manager (§4)
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
   bucket's location, the SSH key selected, public IPv4 and IPv6, **Backups
   off**, no volumes, firewalls, placement group, labels or cloud config. Note
   `IP`. No key selected means Hetzner emails a root password instead: delete
   the server and create it again with the key.
2. **DNS** (the zone: §4). Point the A and AAAA records of the app and API
   hostnames at the new server (IPv6: the `::1` of its `/64`). Check:
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
5. **Database**, before any deploy. First the backup bucket's values, on the Mac:
   ```
   cp deploy/backup/backup-bucket.env.example ~/.vitrina/backup-bucket.env && chmod 600 ~/.vitrina/backup-bucket.env
   ```
   The template holds names only: fill every value from the password manager's
   backup-bucket entry (`s3.mjs: missing BACKUP_…` means one is empty). Then
   the age key: copy the entry "Vitrina backup key (age)" and, at once:
   ```
   deploy/backup/agekey.sh
   AGE_IDENTITY=~/vitrina-backup.agekey deploy/backup/recover.sh $IP $ADMIN
   ```
   `agekey.sh` prints the key's public key: it must equal the entry's
   `# public key:` line. Never `age-keygen -o` here — that makes a new key,
   which decrypts no backup.
6. **Release**: the tag that was live — the newest one deployed (the server
   that recorded it is gone). Its migrations must report `0 applied`; a tag
   that adds migrations is refused (no backups here yet), an older one fails
   (`recorded but missing from disk`).
   ```
   git checkout vX.Y.Z
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

Follow these steps from main's copy of this file (e.g. on GitHub): step 1's
checkout replaces the working tree's.

1. **Window, tag, names.** A new terminal window for all of it, closed at the
   end. The rehearsal restores production's database, so it runs production's
   code from the start: the live tag, read with production's values. Then two
   temporary hostnames under the domain, e.g. `dr-app.` and `dr-api.`:
   ```
   deploy/release/live.sh <production IPv4> <production admin>
   git status                       # clean
   git checkout <live tag>          # every script below is the tag's own
   export VITRINA_APP_HOST=<temporary app hostname> VITRINA_API_HOST=<temporary API hostname>
   ```
   `untagged`: tag it first, as §5 step 8. Set `KEY` and `ADMIN` (any name for
   the rehearsal's admin user), and start a password-manager entry for that
   name; its sudo password joins it in step 4.
2. **Hetzner:** a new project for the rehearsal. In it:
   - **Security → SSH keys:** add the public key (`pbcopy < $KEY.pub`). Keys
     belong to a project: production's is not visible here;
   - a server as in 1a step 1 (any location), with that key selected. Set `IP`;
   - an empty, private bucket, and **Security → S3 credentials** for it. The
     secret key is shown once.

   Then the bucket's file:
   ```
   cp deploy/storage/storage.env.example ~/.vitrina/rehearsal-storage.env && chmod 600 ~/.vitrina/rehearsal-storage.env
   ```
   The template holds names only: fill every value — the endpoint and region of
   the bucket's location as the console shows them, the bucket's name, both
   keys. New credentials can take minutes to work everywhere; `copy-media.mjs`
   waits up to 5 minutes for them.
3. **DNS** (the zone: §4): A and AAAA records for the two temporary names only,
   pointing at the rehearsal server. Check with `dig`.
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
   After a failure, run it again: it resumes a partial copy. It refuses a
   target holding anything production's `media/` does not, and production's
   buckets by name.
6. **Configure** as 1a step 4, with `--restore-secret` and `--allow`, but the
   storage values of the **rehearsal** bucket. Then `check-config.sh`.
7. **Database, release, checks:** 1a steps 5 and 6 (already on the live tag;
   `deploy.sh`, `verify.sh` and `public-check.mjs` use the exported names).
8. **Proof:** at `https://$VITRINA_APP_HOST`, sign in with an owner's real
   password — it works only if the server secret was restored — and see the
   albums and photos. Make a new invite there and open it on another device.
   (Invites made in production point at production and are not used here.)
9. **Teardown**, the same day: the rehearsal server holds production's secret
   and a copy of its database.
   - **Empty the bucket** — Hetzner deletes only empty buckets — from main
     (the tag may predate the script):
     ```
     git checkout main
     node deploy/backup/empty-bucket.mjs ~/.vitrina/rehearsal-storage.env <rehearsal bucket name>
     ```
   - Hetzner: delete the rehearsal server, then its bucket, then its S3
     credentials, then the rehearsal project;
   - DNS: delete the temporary records (A and AAAA, both names), only those;
   - Mac:
     ```
     rm ~/.vitrina/rehearsal-storage.env ~/.vitrina/backup-bucket.env ~/vitrina-backup.agekey
     ssh-keygen -R $IP
     unset VITRINA_APP_HOST VITRINA_API_HOST
     ls ~/.vitrina/                   # storage.env only
     ```
     then close the window;
   - password manager: delete the rehearsal admin entry, and any rehearsal S3
     keys saved; email: Hetzner's root-password message, if one came.

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
6. **Release:** tag main `v0.1.0` (§3, deploy a release, step 1), then
   `deploy/release/deploy.sh $IP $ADMIN` and `deploy/release/verify.sh $IP $ADMIN`.
7. **Backups:** a new age key (`age-keygen -o ~/vitrina-backup.agekey`, the whole
   file to the password manager; `age-keygen -y` gives the public key), a backup
   bucket in a separate project and location, then 1a step 7.
8. **Monitoring:** §4's monitor and heartbeat. Prove both by violation: stop the
   API (`sudo systemctl stop vitrina-api`) until the alert arrives, start it;
   shorten the heartbeat's period until it alerts, restore it.

---

## 3. Day-to-day

**Deploy a release.** Only tags on `main` are deployable.

1. **Tag** main and push the tag. Tags never move: a fix is a new tag.
   ```
   git checkout main && git pull
   git tag -a vX.Y.Z -m vX.Y.Z && git push origin vX.Y.Z
   git checkout vX.Y.Z
   ```
2. **Staging** (§5) first if the release adds a migration, or touches
   accounts, keys or deletion.
3. **Backup**, if it adds a migration, within the hour before step 4 — the
   age key from the password manager first (`agekey.sh`, 1a step 5), deleted after:
   ```
   pnpm infra:up && pnpm infra:wait && pnpm --filter @vitrina/server build
   AGE_IDENTITY=~/vitrina-backup.agekey deploy/backup/restore-test.sh $IP $ADMIN
   ```
   It runs `backup-now.sh` and proves the backup restores. Without a backup
   under an hour old in the bucket, `deploy.sh` refuses before the server
   changes.
4. **Deploy** — `deploy.sh` refuses unless the checkout is a `vX.Y.Z` tag on
   `origin/main`, also on origin, with a clean tree:
   ```
   deploy/release/deploy.sh $IP $ADMIN
   deploy/release/verify.sh $IP $ADMIN        # optional; restarts the API four times
   ```
5. **Tell the testers**: two lines about anything they will see — new,
   changed or gone. Nothing visible, nothing sent.

**What's live** — prints the tag:
```
deploy/release/live.sh $IP $ADMIN
```

**Roll back** — to the release live before this one:
```
deploy/release/rollback.sh $IP $ADMIN
```
Both `current` links, the API restarted, `/health` awaited, the tag now live
printed. Refuses when no previous release is recorded, and a second time in a
row: the rule below covers the previous release, not the one before it. It
never touches the database: what the newer release migrated stays migrated,
which is safe only under the migration rule. The older tag then cannot be
deployed again (`migrate.mjs`: recorded but missing from disk) — fix forward,
with a new tag.

**The migration rule** — every migration works with the previous release's
code: add first, use later, remove last. The previous release runs on the new
schema twice: while `deploy.sh` migrates, before the switch; and after any
rollback. So a new column is nullable or has a default, and nothing the
previous release writes violates a new constraint; a column or table goes only
in a release after the one that stopped reading and writing it; a rename is an
add, a copy, and two releases later a remove. Enforced where it can be: the
backup in step 3, and staging's rollback (§5 step 9). The rest is review.

**Once, by violation** — the guards that need a server:
- rollback with nothing before: §5 step 8, on staging;
- an app built for another host: §5 step 8, on staging;
- the backup rule: the first release with a migration, step 4 before step 3 —
  `deploy.sh` must refuse, and the server is unchanged (`live.sh`).

**Add an address to the allowlist** — the list is rewritten whole, so give every
address, old and new:
```
deploy/server/push.sh $IP $ADMIN
ssh -t -i $KEY $ADMIN@$IP sudo bash vitrina-server/configure.sh --allow <every address, comma-separated>
deploy/server/check-config.sh $IP $ADMIN
```

**Rerun the restore test** — copy the entry "Vitrina backup key (age)" first;
delete `~/vitrina-backup.agekey` after:
```
deploy/backup/agekey.sh
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

**DNS** — the domain's zone, on Hetzner's older DNS service: edited in Hetzner
Robot or konsoleH, not the Cloud Console (which shows no zones). A and AAAA
records for the app and API hostnames. A rehearsal's or staging's temporary
records go into this zone; a zone is never created or imported.

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
- admin user: its name and its sudo password, one entry
- during a rehearsal or staging: that server's admin entry, the same way;
  deleted at teardown
- SSH key passphrase
- Better Stack heartbeat URL
- accounts: Hetzner Cloud, Hetzner Robot or konsoleH (the DNS zone), Better Stack

**On the server, written by scripts, root-only**
- `/opt/vitrina/history` — the last two releases that went live, the live one
  last (release.sh, rollback-server.sh; readable by all). What's live is the
  `current` links: `live.sh`
- `/etc/vitrina/site.env` — the two hostnames (provision.sh)
- `/etc/vitrina/api.env` — origin, database URL, server secret, media bucket (configure.sh)
- `/etc/vitrina/signup.env` — the allowlist (configure.sh)
- `/etc/vitrina/backup.env` — backup bucket, age public key, retention, heartbeat URL (backup-setup.sh)

**On the Mac, outside the repository**
- `~/.ssh/vitrina_hetzner`, `.pub`
- `~/.vitrina/storage.env` — the media bucket's values
- during a recovery only: `~/.vitrina/backup-bucket.env`
  (names: `deploy/backup/backup-bucket.env.example`), `~/vitrina-backup.agekey`
  (`agekey.sh`)
- during a rehearsal only: `~/.vitrina/rehearsal-storage.env`
- during staging only: `~/.vitrina/staging-storage.env`, and the recovery files above

**Schedule**
- nightly backup: 03:15 UTC (+ up to 10 min); retention and minimum kept: in `backup.env`
- automatic security updates daily; reboots when needed at 04:00 UTC
- journald keeps 14 days

---

## 5. Staging, on demand

A throwaway copy of production for one release: built, used, deleted the same
day. **When:** the release adds a migration, or touches accounts, keys or
deletion. Not otherwise.

It is §1b's rehearsal with the candidate deployed on it:

- **its own** Hetzner project, server, bucket and bucket credentials, and two
  temporary hostnames. Production's media and backup credentials stay on the
  Mac (`copy-media.mjs` and `recover.sh` read with them); the staging server
  never holds them;
- production's database (the newest backup) and a copy of its photos —
  ciphertext;
- **production's server secret, the one exception.** The restored owners'
  password hashes are peppered with it: without it nobody signs in. It arrives
  only through `configure.sh --restore-secret`, pasted from the password
  manager, and exists only in staging's `/etc/vitrina/api.env`. Beside the
  database copy it makes staging as sensitive as production. **The owner
  deletes it**, by deleting the server in step 10, the same day;
- no backups and no monitoring. The backup rule does not apply here: its API
  host is not production's, and `release.sh` says so.

Use a **new terminal window** for all of it, with `IP` set to the staging
server's; close it at the end. A deploy built in the wrong window is refused
before anything changes (`release.sh`: the app was built for another host).

1. **Names:** `export VITRINA_APP_HOST=stg-app.<domain> VITRINA_API_HOST=stg-api.<domain>`
2. **Hetzner:** a new project, e.g. `staging-vX.Y.Z`, set up as 1b step 2 (the
   SSH key, the server, the bucket and its credentials), with
   `~/.vitrina/staging-storage.env` for the bucket's values. Set `IP`, and an
   admin entry in the password manager.
3. **DNS:** A and AAAA records for the two temporary names only (1b step 3).
4. **Provision:** 1b step 4.
5. **Photos:**
   ```
   node deploy/backup/copy-media.mjs ~/.vitrina/storage.env ~/.vitrina/staging-storage.env
   ```
6. **Configure:** with the staging bucket's values, production's secret, the owners' addresses:
   ```
   deploy/server/push.sh $IP $ADMIN
   ssh -t -i $KEY $ADMIN@$IP sudo bash vitrina-server/configure.sh --restore-secret --allow <addresses>
   deploy/server/check-config.sh $IP $ADMIN
   ```
7. **Database:** production's newest backup. For a migration release, take §3's
   step 3 against production first: that backup is the one restored here, and
   it opens the hour for production's deploy (past the hour, take it again).
   ```
   AGE_IDENTITY=~/vitrina-backup.agekey deploy/backup/recover.sh $IP $ADMIN
   ```
8. **Releases:** production's live tag first (`live.sh <production IP> $ADMIN`),
   then the candidate. While production is `untagged`, tag the commit its
   release name ends with, if it is on main; otherwise deploy the candidate
   alone, and step 9 has nothing to roll back to.
   ```
   git checkout <live tag> && deploy/release/deploy.sh $IP $ADMIN   # 0 applied
   git checkout vX.Y.Z
   deploy/release/rollback.sh $IP $ADMIN                             # must refuse: nothing before
   (unset VITRINA_API_HOST VITRINA_APP_HOST; deploy/release/deploy.sh $IP $ADMIN)  # must refuse: built for production
   deploy/release/deploy.sh $IP $ADMIN                               # applies the new migrations
   deploy/release/verify.sh $IP $ADMIN
   ```
   A checkout's deploy scripts are its own: the live tag deploys with the
   scripts it was tagged with. The two refusals are once only (§3, once by
   violation), from the candidate's checkout. Then, on a phone at
   `https://$VITRINA_APP_HOST`: sign in as an owner, and walk what the release
   touches — the account, key or deletion flow.
9. **The migration rule** (migration releases): the previous release on the new schema.
   ```
   deploy/release/rollback.sh $IP $ADMIN     # back to the live tag; the migrations stay
   deploy/release/verify.sh $IP $ADMIN
   ```
   A failure here is the migration breaking the rule: fix it before production.
10. **Teardown**, the same day:
    - **Empty the bucket** (Hetzner deletes only empty buckets):
      ```
      node deploy/backup/empty-bucket.mjs ~/.vitrina/staging-storage.env <staging bucket name>
      ```
    - Hetzner: delete the staging server — production's server secret and
      database copy go with it — then its bucket, its credentials, and the project;
    - DNS: delete the temporary records (A and AAAA, both names), only those;
    - Mac: as 1b step 9, with `staging-storage.env`; close the window;
    - password manager: delete the staging admin entry.

Then §3, deploy a release, step 4, in production's window.
