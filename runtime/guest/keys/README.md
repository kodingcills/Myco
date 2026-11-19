# Guest SSH keys (RT-003)

`id_ed25519` / `id_ed25519.pub` — ed25519 keypair for host→guest SSH (port 10022)
into the `myco` user of the runtime v0 Linux guest.

The **private key is gitignored** (see `runtime/guest/.gitignore`) because the guest
it is paired with is disposable; the cloud-init seed (`seed/user-data`) authorizes
the public key. If the keypair is missing, regenerate with:

    ssh-keygen -t ed25519 -N '' -C myco-rt-guest -f runtime/guest/keys/id_ed25519

and re-provision the guest (`create-overlay.sh --recreate && boot.sh`), since the
authorized key is baked in by cloud-init.
