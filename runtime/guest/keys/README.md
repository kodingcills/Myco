# Guest SSH keys (RT-003)

`id_ed25519` / `id_ed25519.pub`: the ed25519 keypair for host→guest SSH (port 10022)
into the `myco` user of the runtime v0 Linux guest.

**Both keys are gitignored** (see `runtime/guest/.gitignore`) because the guest they
are paired with is disposable. The public key used to be tracked, which meant every
fresh checkout regenerated it and showed a modified tracked file (TIF-111 verifier).
The cloud-init seed (`seed/user-data`) authorizes the public key on the overlay's
first boot only, so a new key needs a new overlay.

**If the private key is missing**, run:

    runtime/guest/shutdown.sh      # if a guest is running; provision.sh refuses otherwise
    runtime/guest/provision.sh     # new keypair; discards the old overlay; re-seeds

Don't generate a key by hand over an existing overlay. The guest would boot and then
refuse SSH, because cloud-init doesn't re-apply keys. `make-seed.sh` (and so
`boot.sh`) refuses that case.

**If only the `.pub` is missing, empty, or wrong**, nothing needs re-provisioning.
`make-seed.sh` and `provision.sh` rebuild it from the private key, which is the
identity SSH presents.
