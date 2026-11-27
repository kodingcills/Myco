# Host requirements for the public-benchmark R1 (OSWorld): for Tiffany's decision

> **Nothing here has been downloaded, pulled or started.** No VM, container or paid box was
> used to write this page (lead hard limit). A second VM or any paid box needs Tiffany's OK.
> Every fact below comes from OSWorld's own source at the pin, `0ad41bee56565efe7bb3c3a5ebc67590a1b8276f`,
> with the file it comes from. Sizes that the source does not state are marked **not verified**:
> `huggingface.co` and Docker Hub are not reachable from the build environment, and nothing
> was pulled to measure them.

## What has to run

- OSWorld's own `DesktopEnv`: one Ubuntu desktop VM per parallel environment, with its in-VM
  controller (an HTTP server on guest port 5000).
- OSWorld's standard Claude runner, `scripts/python/run_multienv_claude.py`, plus Myco's DONE
  gate hook, on the host that drives the VMs.
- The `myco-gate` MCP server, for arm (b) only. It is a Node process, started once per
  DONE check by the hook.

## Provider options (the pinned runner's `--provider_name`)

| Provider | What it needs | Image (source file) | Notes |
|---|---|---|---|
| `docker` | Docker Engine; **KVM** (`/dev/kvm`) strongly recommended, which means bare-metal Linux or a cloud VM with nested virtualisation. Without KVM, QEMU runs unaccelerated: "will be slower" (`desktop_env/providers/docker/provider.py`). | Container image `happysixd/osworld-docker` (pulled on first use), running the qcow2 disk `Ubuntu.qcow2.zip` from `huggingface.co/datasets/xlangai/ubuntu_osworld` (`desktop_env/providers/docker/manager.py`). Sizes: **not verified**. | Defaults per container: `DISK_SIZE 32G`, `RAM_SIZE 4G`, `CPU_CORES 4`, plus `cap_add NET_ADMIN` (with a fallback without it). Ports published on localhost: 8006 (VNC), 5000 (controller), 9222 (Chrome), 8080 (VLC). OSWorld's own Docker guide: "macOS hosts generally do not support KVM. You are advised to use VMware … on macOS." |
| `vmware` | VMware Workstation Pro (Linux/Windows) or VMware Fusion (macOS, including Apple silicon), with `vmrun` | `Ubuntu-x86.zip` or `Ubuntu-arm.zip` from `huggingface.co/datasets/xlangai/ubuntu_osworld` (`desktop_env/providers/vmware/manager.py`). Sizes: **not verified**. | The only provider OSWorld recommends for a Mac. Apple silicon uses the arm image. Whether the arm image gives the same task outcomes as x86 is not established. |
| `virtualbox` | VirtualBox | `Ubuntu.zip` from `huggingface.co/datasets/xlangai/ubuntu_x86_virtualbox` (`desktop_env/providers/virtualbox/manager.py`). Size: **not verified**. | OSWorld's README: parallelism and Apple silicon "might not be well-supported". |
| `aws` | An AWS account and keys (`AWS_*` environment variables), a VPC subnet and a security group | OSWorld's public AMIs (`desktop_env/providers/aws/manager.py`, `IMAGE_ID_MAP`) | Client instances default to `t3.xlarge` (4 vCPU, 16 GiB). OSWorld's guide recommends a host instance of `t3.medium` (fewer than 5 environments) or `t3.large` (fewer than 15), with at least 50 GB of storage (`SETUP_GUIDELINE.md` §3). **Paid.** |
| `azure`, `pyromind` | Accounts for those clouds | Their own images | **Paid.** Not considered further here. |

**Runner quirk.** The pinned Claude runner always imports `desktop_env.providers.aws.manager`
to look up an AMI id, even when the provider is not AWS. So the host needs the AWS SDK
(`boto3`) installed, but not AWS credentials.

## Sizing for this R1

- **Per environment:** 4 vCPU, 4 GB RAM and a 32 GB
  guest disk (Docker defaults). Add space for the downloaded image, and host headroom on top
  of the guest RAM (Myco's suggestion, not upstream's).
- **The runner:** `run_single_example` waits a fixed 60 s after each reset and 20 s before
  `evaluate()`, so each task costs at least 80 s of wall clock on top of its agent steps.
- **Total trials:** 117 tasks × 3 arms = 351 trials at n = 117 with one trial per arm.
  `--num_envs` sets how many run in parallel.
- **Host Python:** the packages in OSWorld's `requirements.txt` at the pin. The Anthropic
  SDK is among them.

## Network and egress

- **Model API:** the runner calls the Anthropic API (or Bedrock or Vertex) through
  `mm_agents/anthropic/utils.py`, so it needs an API key or cloud credentials. This conflicts
  with M2's $0-API rule (Claude Ultra plan) and is the pending ruling `model-access`. Under
  the secret rules, any key is loaded from a file at the point of use and never passed in
  argv or the environment of a Myco process.
- **Image download:** `huggingface.co` (or the `hf-mirror.com` mirror the providers support),
  and Docker Hub for `happysixd/osworld-docker`.
- **Task assets:** each task's own setup step downloads its seed files inside the guest from
  `huggingface.co/datasets/xlangai/ubuntu_osworld_file_cache`. The gold files come from the
  same place, through the `cloud_file` getter. This is gated on the pending ruling
  `asset-license`.
- **Guest internet:** the guest needs outbound HTTPS for those downloads. The runner
  constructs `DesktopEnv` with `enable_proxy=False`, and no task in the subset sets
  `proxy: true` (`requirements.md`).
- **Inbound:** only the localhost ports listed above (Docker). Nothing is exposed publicly.

## Options for the decision (Myco does not choose)

1. **A Linux box with KVM** (bare metal, or a cloud VM with nested virtualisation), using the
   `docker` provider. This matches OSWorld's recommended path.
2. **The owner's Mac with VMware Fusion**, using the `vmware` provider and the arm image on
   Apple silicon. This is a second VM on the shared Mac, which the trial run also uses.
3. **AWS**, using OSWorld's own parallel platform. Paid, and the fastest at scale.

Each option needs, before any run: the `asset-license`, `model`, `model-access`, `budget`,
`n`, `pass-threshold` and `gate-oracle` rulings, and Tiffany's OK for the box.
