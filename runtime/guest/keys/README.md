# Guest SSH keys (RT-003)

`id_ed25519` / `id_ed25519.pub` — ed25519 keypair for host→guest SSH (port 10022)
into the `myco` user of the runtime v0 Linux guest.

**Both keys are gitignored** (see `runtime/guest/.gitignore`) because the guest they
are paired with is disposable. The public key used to be tracked, which meant every
fresh checkout regenerated it and showed a modified tracked file (TIF-111 verifier); the cloud-init seed (`seed/user-data`) authorizes
the public key. If the keypair is missing, regenerate with:

    ssh-keygen -t ed25519 -N '' -C myco-rt-guest -f runtime/guest/keys/id_ed25519

and re-provision the guest (`create-overlay.sh --recreate && boot.sh`), since the
authorized key is baked in by cloud-init.
