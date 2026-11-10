# Backing up the archive

**Stub.** Verified backup and restore (`plaudport backup verify`, PRD
FR14d) and biometric-store key recovery (FR14e) are milestone **P5** work and
are not implemented yet.

What holds today (P0):

- The archive at `PLAUDPORT_ARCHIVE_ROOT` is the system of record. The SQLite
  ledger under `.plaudport/` is derived: `plaudport index rebuild` recreates it
  from the recording manifests alone (FR14c). Back up the whole archive root;
  the ledger can be skipped.
- Each recording's `manifest.json` lists a sha256 for its audio and every
  artifact, so a restored copy can be checked: `plaudport report
  --verify-audio N` re-hashes a sample of audio files.
- `plaudport doctor` warns while the archive is on the boot volume and
  `PLAUDPORT_BACKUP_HINT` is empty (FR14a). Set it only once a backup really
  exists.

Until FR14d's restore has been exercised once, Plaud is not treated as a mere
transit buffer (PRD §8): nothing is deleted from Plaud, ever.
