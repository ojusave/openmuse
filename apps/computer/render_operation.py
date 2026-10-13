"""Run one operation and export only a bounded workspace of regular files."""
# This file runs only inside a fresh Render Sandbox. It receives a checked
# request and saved files from the OpenMuse API, then exports the new files.
# Standard-library modules decode bytes, inspect file types, run commands,
# and stop command children that exceed their time limit.
import base64
import json
import os
import signal
import stat
import subprocess

# Only /workspace is durable. The control folder holds temporary request and
# answer files that the API downloads before it terminates the sandbox.
ROOT = "/workspace"
CONTROL = "/tmp/openmuse-control"
MAX_BYTES = 10 * 1024 * 1024
MAX_ENTRIES = 1000
OUTPUT_LIMIT = 128 * 1024


def safe_path(relative):
    """Turn a saved relative name into a workspace path, rejecting parent traversal."""
    if not isinstance(relative, str) or not relative or relative.startswith("/"):
        raise ValueError("Invalid saved workspace path")
    if any(part in ("", ".", "..") for part in relative.split("/")) or "\0" in relative:
        raise ValueError("Invalid saved workspace path")
    return os.path.join(ROOT, relative)


def restore(entries):
    """Rebuild saved files inside this fresh Render computer, never on the app server."""
    if len(entries) > MAX_ENTRIES:
        raise ValueError("Workspace exceeds 1000 entries")
    os.makedirs(ROOT, exist_ok=True)
    total = 0
    # Directories and regular files are the only durable types. Restore every
    # byte under /workspace, with private permissions and no inherited secrets.
    for entry in entries:
        path = safe_path(entry["path"])
        if entry["type"] == "directory":
            os.makedirs(path, mode=0o700, exist_ok=True)
        elif entry["type"] == "file":
            content = base64.b64decode(entry["data"], validate=True)
            total += len(content)
            if total > MAX_BYTES:
                raise ValueError("Workspace exceeds 10 MB")
            os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
            with open(path, "wb") as output:
                output.write(content)
            os.chmod(path, 0o700 if entry.get("executable") else 0o600)
        else:
            raise ValueError("Only regular files and directories can be restored")


def capture():
    """Collect only ordinary files and folders for durable storage in the app database."""
    entries = []
    total = 0
    # Walk the completed workspace and reject links or device-like files.
    # The API keeps its prior saved version if this export cannot be completed.
    for current, directories, files in os.walk(ROOT, followlinks=False):
        for name in sorted(directories + files):
            path = os.path.join(current, name)
            info = os.lstat(path)
            relative = os.path.relpath(path, ROOT)
            if len(entries) >= MAX_ENTRIES:
                raise ValueError("Workspace exceeds 1000 entries; last saved workspace retained")
            if stat.S_ISLNK(info.st_mode):
                raise ValueError("Symlinks cannot be saved; last saved workspace retained")
            if stat.S_ISDIR(info.st_mode):
                entries.append({"path": relative, "type": "directory"})
            elif stat.S_ISREG(info.st_mode):
                fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                with os.fdopen(fd, "rb") as source:
                    if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
                        raise ValueError("Only regular files can be saved")
                    content = source.read(MAX_BYTES - total + 1)
                total += len(content)
                if total > MAX_BYTES:
                    raise ValueError("Workspace exceeds 10 MB; last saved workspace retained")
                entries.append({"path": relative, "type": "file", "data": base64.b64encode(content).decode("ascii"), "executable": bool(info.st_mode & 0o111)})
            else:
                raise ValueError("Special files cannot be saved; last saved workspace retained")
    return entries


def command(request):
    """Run the requested shell command here in Render and preserve its actual exit status."""
    # The user may choose a subfolder, but never a host or control folder.
    # Resolve links before launching Bash so a linked working folder cannot
    # redirect a command outside /workspace.
    cwd = request.get("cwd", ROOT)
    resolved = os.path.realpath(cwd)
    if resolved != ROOT and not resolved.startswith(ROOT + "/"):
        raise ValueError("Working directory must stay inside /workspace")
    timed_out = False
    # Bash runs here in the sandbox, not on the OpenMuse API server. Output
    # goes to temporary files so a noisy program cannot fill process memory.
    with open(CONTROL + "/stdout", "wb+") as stdout, open(CONTROL + "/stderr", "wb+") as stderr:
        # File-backed output keeps a noisy program from filling this helper's memory.
        # A separate process group lets timeout cleanup stop ordinary child processes too.
        process = subprocess.Popen(["/bin/bash", "--noprofile", "--norc", "-c", request["command"]], cwd=cwd, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr, start_new_session=True, env={"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": ROOT, "LANG": "C.UTF-8"})
        try:
            process.wait(timeout=30)
        except subprocess.TimeoutExpired:
            timed_out = True
        finally:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()
        # Return a bounded combined output and the real exit code. Exit 124
        # means the 30-second command limit stopped the process.
        stdout.seek(0)
        stderr.seek(0)
        out = stdout.read(OUTPUT_LIMIT)
        err = stderr.read(OUTPUT_LIMIT - len(out))
        return {"stdout": out.decode("utf-8", "replace"), "stderr": err.decode("utf-8", "replace"), "exitCode": 124 if timed_out else process.returncode, "timedOut": timed_out, "truncated": os.fstat(stdout.fileno()).st_size + os.fstat(stderr.fileno()).st_size > OUTPUT_LIMIT}


def main():
    """Restore inputs, perform one action, and write results for the server to download."""
    with open(CONTROL + "/workspace-in.json") as source:
        restore(json.load(source))
    with open(CONTROL + "/request.json") as source:
        request = json.load(source)
    # A command runs in Bash; file actions use the existing fixed files.py
    # helper. Start only verifies that restoration and export work.
    if request["operation"] == "command":
        result = command(request)
    elif request["operation"] == "start":
        result = {"ready": True}
    else:
        process = subprocess.run(["python3", "-I", CONTROL + "/files.py"], input=json.dumps(request), text=True, capture_output=True, timeout=10)
        if process.returncode:
            raise ValueError(process.stderr[:500])
        result = json.loads(process.stdout)
    # Export the complete checked workspace before saying the action worked.
    # The API validates this file again before storing it for the next run.
    workspace = capture()
    with open(CONTROL + "/workspace-out.json", "w") as target:
        json.dump(workspace, target)
    with open(CONTROL + "/result.json", "w") as target:
        json.dump({"ok": True, "result": result}, target)


try:
    main()
except Exception as error:
    # Do not claim a saved workspace when the export failed.
    with open(CONTROL + "/result.json", "w") as target:
        json.dump({"ok": False, "error": str(error)[:500]}, target)
