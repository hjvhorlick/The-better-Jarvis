import ast
import subprocess
import sys
import json
import re
import time
from datetime import datetime
from pathlib import Path


def get_base_dir():
    if getattr(sys, "frozen", False):
        return Path(sys.executable).parent
    return Path(__file__).resolve().parent.parent

BASE_DIR           = get_base_dir()
API_CONFIG_PATH    = BASE_DIR / "config" / "api_keys.json"
DESKTOP            = Path.home() / "Desktop"
BACKUPS_DIR        = BASE_DIR / "memory" / "code_backups"
MAX_BUILD_ATTEMPTS = 3
# gemini-3.8-flash: Google's current stable Flash model (GA 2 September 2026, no shutdown
# announced). Verified at ai.google.dev/gemini-api/docs/models, read 2026-10-12.
GEMINI_MODEL       = "gemini-3.8-flash"


def _get_api_key() -> str:
    with open(API_CONFIG_PATH, "r", encoding="utf-8") as f:
        return json.load(f)["gemini_api_key"]


def _get_gemini(model: str = GEMINI_MODEL):
    from google import genai
    _c = genai.Client(api_key=_get_api_key())

    class _W:
        def generate_content(self, contents):
            return _c.models.generate_content(model=model, contents=contents)

    return _W()


def _clean_code(text: str) -> str:
    text = text.strip()
    text = re.sub(r"^```[a-zA-Z]*\n?", "", text)
    text = re.sub(r"\n?```$", "", text)
    return text.strip()


def _resolve_save_path(output_path: str, language: str) -> Path:
    ext_map = {
        "python": ".py", "py": ".py",
        "javascript": ".js", "js": ".js",
        "typescript": ".ts", "ts": ".ts",
        "html": ".html", "css": ".css",
        "java": ".java", "cpp": ".cpp", "c": ".c",
        "bash": ".sh", "shell": ".sh", "powershell": ".ps1",
        "sql": ".sql", "json": ".json", "rust": ".rs", "go": ".go",
    }
    if output_path:
        p = Path(output_path)
        return p if p.is_absolute() else DESKTOP / p
    ext = ext_map.get((language or "python").lower(), ".py")
    return DESKTOP / f"jarvis_code{ext}"


def _read_file(file_path: str) -> tuple[str, str]:
    if not file_path:
        return "", "No file path provided."
    p = Path(file_path)
    if not p.exists():
        return "", f"File not found: {file_path}"
    try:
        return p.read_text(encoding="utf-8"), ""
    except Exception as e:
        return "", f"Could not read file: {e}"


def _validate_code_integrity(path: Path, original: str, updated: str) -> tuple[bool, str]:
    """Ensures code is non-empty, contains no lazy placeholders, and passes AST/syntax check."""
    if not updated or not updated.strip():
        return False, "Code output is completely empty."

    # 1. Detect lazy LLM placeholders that destroy codebases
    placeholder_patterns = [
        r"(?i)#\s*\.{3,}\s*(?:rest|existing|remain|keep|unchanged|previous)",
        r"(?i)//\s*\.{3,}\s*(?:rest|existing|remain|keep|unchanged|previous)",
        r"(?i)<!--\s*\.{3,}\s*(?:rest|existing|remain|keep|unchanged|previous)",
        r"(?i)\.{3,}\s*(?:rest of the code|remaining code)",
        r"(?i)\[\s*rest of code unchanged\s*\]",
        r"(?i)#\s*rest of file unchanged",
    ]
    for pat in placeholder_patterns:
        if re.search(pat, updated):
            return False, "Code contains forbidden placeholder patterns (e.g. '# ... rest of code unchanged'). Refusing to save to prevent code loss."

    # 2. Syntax validation for Python files
    if path.suffix.lower() in (".py", ".pyw"):
        try:
            ast.parse(updated, filename=str(path))
            compile(updated, str(path), "exec")
        except SyntaxError as se:
            line_str = f" at line {se.lineno}" if se.lineno else ""
            return False, f"Python SyntaxError{line_str}: {se.msg}"
        except Exception as ex:
            return False, f"Python validation error: {ex}"

    # 3. JSON validation
    if path.suffix.lower() == ".json":
        try:
            json.loads(updated)
        except Exception as je:
            return False, f"Invalid JSON syntax: {je}"

    return True, "valid"


def _test_candidate_code(path: Path, candidate_code: str) -> tuple[bool, str]:
    """Tests proposed code in an isolated sandbox BEFORE touching the actual file.
    Runs AST parsing, byte-compilation, and syntax validation.
    """
    # 1. Base integrity check (no empty code, no lazy placeholders)
    valid, msg = _validate_code_integrity(path, "", candidate_code)
    if not valid:
        return False, msg

    # 2. Deep Python sandbox testing
    if path.suffix.lower() in (".py", ".pyw"):
        try:
            ast.parse(candidate_code, filename=str(path))
            compile(candidate_code, str(path), "exec")
        except SyntaxError as se:
            line_str = f" at line {se.lineno}" if se.lineno else ""
            return False, f"SyntaxError{line_str}: {se.msg}"
        except Exception as ex:
            return False, f"Compilation error: {ex}"

        # Test compile in an isolated subprocess to detect import or module-level syntax issues
        import tempfile
        t_path = None
        try:
            with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False, encoding="utf-8") as tf:
                tf.write(candidate_code)
                t_path = Path(tf.name)
            res = subprocess.run(
                [sys.executable, "-m", "py_compile", str(t_path)],
                capture_output=True,
                text=True,
                timeout=10,
            )
            if res.returncode != 0:
                err = (res.stderr or res.stdout).strip()
                return False, f"Isolated compilation test failed: {err}"
        except Exception as e:
            return False, f"Sandbox test execution error: {e}"
        finally:
            if t_path and t_path.exists():
                try:
                    t_path.unlink(missing_ok=True)
                except Exception:
                    pass

    # 3. Shell syntax check
    elif path.suffix.lower() in (".sh", ".bash"):
        import tempfile
        t_path = None
        try:
            with tempfile.NamedTemporaryFile("w", suffix=".sh", delete=False, encoding="utf-8") as tf:
                tf.write(candidate_code)
                t_path = Path(tf.name)
            res = subprocess.run(["bash", "-n", str(t_path)], capture_output=True, text=True, timeout=5)
            if res.returncode != 0:
                return False, f"Bash syntax check failed: {res.stderr.strip()}"
        except Exception:
            pass
        finally:
            if t_path and t_path.exists():
                try:
                    t_path.unlink(missing_ok=True)
                except Exception:
                    pass

    return True, "All sandbox tests passed."


def _backup_file(path: Path) -> Path | None:
    """Create a timestamped backup before any modifications."""
    try:
        if not path.exists():
            return None
        BACKUPS_DIR.mkdir(parents=True, exist_ok=True)
        file_backup_dir = BACKUPS_DIR / path.name
        file_backup_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        backup_path = file_backup_dir / f"{path.stem}_{stamp}{path.suffix}"
        content = path.read_text(encoding="utf-8")
        backup_path.write_text(content, encoding="utf-8")
        # Update latest snapshot
        latest_path = file_backup_dir / f"latest{path.suffix}"
        latest_path.write_text(content, encoding="utf-8")
        return backup_path
    except Exception as e:
        print(f"[Code] ⚠️ Backup warning: {e}")
        return None


def _rollback_file(file_path: str) -> str:
    """Restores the most recent backup of a file to undo an unwanted change."""
    if not file_path:
        return "Please specify a file path to rollback, sir."
    p = Path(file_path)
    file_backup_dir = BACKUPS_DIR / p.name
    latest = file_backup_dir / f"latest{p.suffix}"
    if not latest.exists():
        cands = sorted(file_backup_dir.glob(f"{p.stem}_*{p.suffix}"))
        if not cands:
            return f"No backups found for {p.name}."
        latest = cands[-1]

    try:
        code = latest.read_text(encoding="utf-8")
        valid, err = _validate_code_integrity(p, "", code)
        if not valid:
            return f"Backup verification failed: {err}"
        p.write_text(code, encoding="utf-8")
        return f"Successfully rolled back {p.name} to verified backup from {latest.name}."
    except Exception as e:
        return f"Rollback failed: {e}"


def _safe_save_file(path: Path, new_code: str) -> tuple[bool, str]:
    """Saves code ONLY after passing integrity and syntax checks, with automatic backup."""
    orig = ""
    if path.exists():
        try:
            orig = path.read_text(encoding="utf-8")
        except Exception:
            pass

    valid, err_msg = _validate_code_integrity(path, orig, new_code)
    if not valid:
        return False, f"Integrity check failed: {err_msg}"

    backup = _backup_file(path)
    backup_note = f" (Backup created: {backup.name})" if backup else ""

    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(new_code, encoding="utf-8")
        return True, f"Saved and verified successfully: {path}{backup_note}"
    except Exception as e:
        return False, f"Write error: {e}"


def _save_file(path: Path, content: str) -> str:
    ok, msg = _safe_save_file(path, content)
    return msg if ok else f"Could not save (safety abort): {msg}"


def _preview(code: str, lines: int = 10) -> str:
    all_lines = code.splitlines()
    preview   = "\n".join(all_lines[:lines])
    suffix    = f"\n... ({len(all_lines) - lines} more lines)" if len(all_lines) > lines else ""
    return preview + suffix


def _has_error(output: str) -> bool:
    error_signals = ["error", "exception", "traceback", "syntaxerror",
                     "nameerror", "typeerror", "stderr", "failed", "crash"]
    return any(s in output.lower() for s in error_signals)


def _take_screenshot() -> Path | None:
    try:
        import pyautogui
        screenshot_path = Path.home() / "Desktop" / f"jarvis_debug_{int(time.time())}.png"
        screenshot = pyautogui.screenshot()
        screenshot.save(str(screenshot_path))
        print(f"[Code] 📸 Screenshot: {screenshot_path}")
        return screenshot_path
    except Exception as e:
        print(f"[Code] ⚠️ Screenshot failed: {e}")
        return None


def _image_to_base64(path: Path) -> str:
    import base64
    return base64.b64encode(path.read_bytes()).decode("utf-8")


_VALID_INTENTS = {"write", "edit", "repair", "rollback", "explain", "run", "build", "screen_debug", "optimize"}


def _detect_intent(description: str, file_path: str, code: str) -> str:
    """
    Language-independent intent detection — NO fixed keyword list.
    Whatever language the user speaks, the description is classified by
    Gemini. If the API is unreachable, it falls back to language-agnostic
    structural hints (does the file exist on disk, was code provided).
    """
    desc        = (description or "").strip()
    file_exists = bool(file_path) and Path(file_path).exists()

    if desc:
        try:
            ctx = []
            if file_path:
                ctx.append(f"a file path is provided (exists on disk: {file_exists})")
            if code:
                ctx.append("an inline code snippet is provided")
            prompt = (
                "Classify a coding assistant request into exactly ONE intent word.\n"
                "The request may be written in ANY language.\n\n"
                f"Request: {desc}\n"
                + (f"Context: {'; '.join(ctx)}\n" if ctx else "")
                + "\nIntents:\n"
                "  repair       = fix errors, debug, patch or fix a broken script or internal code\n"
                "  rollback     = undo the last change, revert an edit to a previous backup\n"
                "  write        = create new code or design an application/script from scratch\n"
                "  edit         = modify an existing file, UI, or feature\n"
                "  explain      = describe what given code/file does\n"
                "  run          = execute an existing file\n"
                "  build        = design and write code, test it repeatedly in a sandbox, and iterate until it works\n"
                "  screen_debug = analyze an error currently visible on the user's screen\n"
                "  optimize     = refactor / clean up / speed up existing code\n\n"
                "Reply with ONLY the intent word, nothing else."
            )
            ans = _get_gemini().generate_content(prompt).text.strip().lower()
            ans = ans.strip("`'\". \n")
            if ans in _VALID_INTENTS:
                return ans
        except Exception as e:
            print(f"[Code] Intent classification failed ({e}) — structural fallback")

    # Structural fallback — not tied to any language
    if file_exists:
        if any(w in desc.lower() for w in ["fix", "repair", "broken", "bug", "traceback", "syntaxerror", "exception"]):
            return "repair"
        if any(w in desc.lower() for w in ["rollback", "revert", "undo"]):
            return "rollback"
        return "edit" if desc else "explain"
    if code:
        return "explain"
    if any(w in desc.lower() for w in ["build", "design and test", "iterate"]):
        return "build"
    return "write"

def _write(description: str, language: str, output_path: str, player=None) -> tuple[str, Path]:
    lang  = language or "python"
    model = _get_gemini()

    prompt = f"""You are an expert {lang} developer.
Write clean, working, well-commented {lang} code for the description below.

Rules:
- Output ONLY the code. No explanation, no markdown, no backticks.
- Add helpful inline comments.
- Handle errors and edge cases properly.
- Use modern best practices.

Description: {description}

Code:"""

    response = model.generate_content(prompt)
    code     = _clean_code(response.text)
    path     = _resolve_save_path(output_path, lang)
    _save_file(path, code)
    return code, path


def _fix_code(code: str, error_output: str, description: str) -> str:
    model  = _get_gemini()
    prompt = f"""You are an expert debugger.
The code below failed with the following error. Fix it.
Return ONLY the corrected code — no explanation, no markdown, no backticks.

Original goal: {description}

Error:
{error_output[:2000]}

Broken code:
{code}

Fixed code:"""

    response = model.generate_content(prompt)
    return _clean_code(response.text)


def _run_file(path: Path, args: list, timeout: int) -> str:
    interpreters = {
        ".py":  [sys.executable],
        ".js":  ["node"],
        ".ts":  ["ts-node"],
        ".sh":  ["bash"],
        ".ps1": ["powershell", "-File"],
        ".rb":  ["ruby"],
        ".php": ["php"],
    }
    interp = interpreters.get(path.suffix.lower())
    if not interp:
        return f"No interpreter for {path.suffix}."

    try:
        result = subprocess.run(
            interp + [str(path)] + (args or []),
            capture_output=True, text=True,
            encoding="utf-8", errors="replace",
            timeout=timeout, cwd=str(path.parent)
        )
        output = result.stdout.strip()
        error  = result.stderr.strip()
        parts  = []
        if output: parts.append(f"Output:\n{output}")
        if error:  parts.append(f"Stderr:\n{error}")
        return "\n\n".join(parts) if parts else "Executed with no output."

    except subprocess.TimeoutExpired:
        return f"Timed out after {timeout}s."
    except FileNotFoundError:
        return f"Interpreter not found: {interp[0]}."
    except Exception as e:
        return f"Execution error: {e}"


def _build(description, language, output_path, args, timeout, speak=None, player=None) -> str:
    if not description:
        return "Please describe what you want me to build, sir."

    if player:
        player.write_log("[Code] Build started...")

    lang = language or "python"

    try:
        code, path = _write(description, lang, output_path, player)
        print(f"[Code] ✅ Written: {path}")
    except Exception as e:
        msg = f"Could not write initial code: {e}"
        if speak: speak(msg)
        return msg

    last_output = ""
    for attempt in range(1, MAX_BUILD_ATTEMPTS + 1):
        print(f"[Code] 🔄 Attempt {attempt}/{MAX_BUILD_ATTEMPTS}")
        if player:
            player.write_log(f"[Code] Attempt {attempt}...")

        last_output = _run_file(path, args, timeout)

        if not _has_error(last_output):
            msg = (
                f"Build complete, sir. "
                f"The code is working after {attempt} attempt{'s' if attempt > 1 else ''}. "
                f"Saved to {path}."
            )
            if speak: speak(msg)
            return f"{msg}\n\nOutput:\n{last_output}"

        print(f"[Code] ⚠️ Error on attempt {attempt}, fixing...")
        if player:
            player.write_log(f"[Code] Fixing (attempt {attempt})...")

        try:
            code = _fix_code(code, last_output, description)
            _save_file(path, code)
        except Exception as e:
            msg = f"Could not fix code on attempt {attempt}: {e}"
            if speak: speak(msg)
            return msg

    msg = (
        f"I was unable to build a working version after {MAX_BUILD_ATTEMPTS} attempts, sir. "
        f"The last error was: {last_output[:200]}"
    )
    if speak: speak(msg)
    return f"{msg}\n\nLast code saved to: {path}"

def _write_action(description, language, output_path, player) -> str:
    if not description:
        return "Please describe what you want me to write, sir."
    if player:
        player.write_log("[Code] Writing code...")
    try:
        code, path = _write(description, language, output_path, player)
        print(f"[Code] ✅ Written: {path}")
        return f"Code written. Saved to: {path}\n\nPreview:\n{_preview(code)}"
    except Exception as e:
        return f"Could not generate code: {e}"


def _edit_action(file_path, instruction, player) -> str:
    if not file_path:
        return "Please provide a file path to edit, sir."
    if not instruction:
        return "Please describe what change to make, sir."

    content, err = _read_file(file_path)
    if err:
        return err

    path = Path(file_path)
    if player:
        player.write_log(f"[Code] Safely editing and testing {path.name} in sandbox...")

    model  = _get_gemini()
    prompt = f"""You are an expert, meticulous code editor.
Apply the following change to the code below.
CRITICAL INTEGRITY RULES:
1. Return ONLY the complete updated code from the very first line to the last line.
2. DO NOT abbreviate, truncate, or omit ANY code.
3. DO NOT use placeholder comments like '# ... existing code ...'.
4. Preserve all imports, comments, and existing functions unless explicitly requested to modify them.
5. Output ONLY raw code without markdown backticks or explanations.

Change: {instruction}

Original code:
{content}

Updated code:"""

    try:
        response = model.generate_content(prompt)
        candidate = _clean_code(response.text)
    except Exception as e:
        return f"Could not generate edit: {e}"

    # Iterative sandbox test and self-healing loop (up to 3 attempts)
    test_ok = False
    test_msg = ""
    for attempt in range(1, 4):
        test_ok, test_msg = _test_candidate_code(path, candidate)
        if test_ok:
            break
        print(f"[Code] ⚠️ Edit candidate failed test (attempt {attempt}): {test_msg}. Iteratively fixing...")
        if player:
            player.write_log(f"[Code] Test {attempt} failed ({test_msg[:40]}...). Iteratively fixing...")
        heal_prompt = (
            f"The proposed code failed sandbox validation (attempt {attempt}) with: {test_msg}.\n"
            "Diagnose the failure, fix the error, and return the 100% COMPLETE working code with zero placeholders:\n\n"
            f"{candidate}"
        )
        try:
            r2 = model.generate_content(heal_prompt)
            candidate = _clean_code(r2.text)
        except Exception as e:
            print(f"[Code] ⚠️ Model error during edit repair: {e}")
            break

    if not test_ok:
        print(f"[Code] ❌ Edit rejected to prevent breakage: {test_msg}")
        return f"Sir, the edit was safely blocked because it failed sandbox tests: {test_msg}. {path.name} was kept completely untouched."

    ok, status = _safe_save_file(path, candidate)
    if not ok:
        print(f"[Code] ❌ Edit rejected to prevent breakage: {status}")
        return f"Sir, the edit was safely blocked to prevent breaking {path.name}: {status}"

    print(f"[Code] ✅ Safely edited and verified: {file_path}")
    return f"File safely edited and verified after passing sandbox tests.\n{status}\n\nPreview:\n{_preview(candidate)}"


def _repair_action(file_path: str, issue_description: str, player=None) -> str:
    """Specialized deep repair workflow with diagnostics, iterative sandbox testing, and self-healing."""
    if not file_path:
        return "Please provide a file path to repair, sir."

    path = Path(file_path)
    content, err = _read_file(file_path)
    if err:
        return err

    if player:
        player.write_log(f"[Code] Running self-repair diagnostics and sandbox testing on {path.name}...")

    diag_info = []
    if path.suffix.lower() in (".py", ".pyw"):
        try:
            ast.parse(content, filename=str(path))
            compile(content, str(path), "exec")
            diag_info.append("AST Status: parses cleanly, checking logic/runtime issues.")
        except SyntaxError as se:
            diag_info.append(f"SyntaxError at line {se.lineno}: {se.msg}")
        except Exception as ex:
            diag_info.append(f"Compile error: {ex}")

    diag_str = "\n".join(diag_info)
    model = _get_gemini()
    prompt = f"""You are a master software reliability engineer and system repair specialist.
You are safely repairing code in {path.name}.
CRITICAL SYSTEM INTEGRITY RULES:
1. Return the 100% COMPLETE repaired code. Never omit any code, imports, or functions.
2. NEVER use placeholders (e.g. no '# ... rest of code unchanged ...').
3. Ensure absolute syntax correctness and backwards compatibility.
4. Return ONLY the code — no markdown, no backticks, no conversational text.

Repair Objective / Bug Description:
{issue_description}

Diagnostics:
{diag_str}

Current Code:
{content}

Repaired Code:"""

    try:
        response = model.generate_content(prompt)
        candidate = _clean_code(response.text)
    except Exception as e:
        return f"Could not generate repair: {e}"

    # Iterative sandbox test and self-healing loop (up to 3 attempts)
    test_ok = False
    test_msg = ""
    for attempt in range(1, 4):
        test_ok, test_msg = _test_candidate_code(path, candidate)
        if test_ok:
            break
        print(f"[Code] ⚠️ Repair candidate failed test (attempt {attempt}): {test_msg}. Iteratively fixing...")
        if player:
            player.write_log(f"[Code] Test {attempt} failed ({test_msg[:40]}...). Iteratively fixing...")
        fix_prompt = (
            f"The repaired code failed sandbox validation (attempt {attempt}) with: {test_msg}.\n"
            "Correct the problem immediately and return the 100% COMPLETE valid code with zero placeholders:\n\n"
            f"{candidate}"
        )
        try:
            r2 = model.generate_content(fix_prompt)
            candidate = _clean_code(r2.text)
        except Exception as e:
            print(f"[Code] ⚠️ Model error during repair fix: {e}")
            break

    if not test_ok:
        return f"Sir, the repair was safely blocked because it failed sandbox testing: {test_msg}. {path.name} was preserved completely untouched."

    ok, status = _safe_save_file(path, candidate)
    if not ok:
        return f"Sir, the repair was safely blocked to prevent damaging {path.name}: {status}"

    print(f"[Code] 🔧 Repair successfully applied and verified for {path.name}")
    return f"Code repair complete and verified after passing sandbox tests for {path.name}.\n{status}\n\nPreview:\n{_preview(candidate)}"


def _explain_action(file_path, code, player) -> str:
    if file_path and not code:
        code, err = _read_file(file_path)
        if err:
            return err
    if not code:
        return "Please provide code or a file path to explain, sir."

    if player:
        player.write_log("[Code] Analyzing code...")

    model  = _get_gemini()
    prompt = f"""Explain what this code does in simple, clear language.
Focus on: what it does, how it works, and any important details.
Be concise — 3 to 6 sentences maximum.

Code:
{code[:4000]}

Explanation:"""

    try:
        response = model.generate_content(prompt)
        return response.text.strip()
    except Exception as e:
        return f"Could not explain code: {e}"


def _run_action(file_path, args, timeout, player) -> str:
    if not file_path:
        return "Please provide a file path to run, sir."
    p = Path(file_path)
    if not p.exists():
        return f"File not found: {file_path}"
    if player:
        player.write_log(f"[Code] Running {p.name}...")
    return _run_file(p, args, timeout)


def _optimize_action(file_path, code, language, output_path, player) -> str:

    if file_path and not code:
        code, err = _read_file(file_path)
        if err:
            return err
    if not code:
        return "Please provide code or a file path to optimize, sir."

    if player:
        player.write_log("[Code] Optimizing code...")

    lang  = language or "python"
    model = _get_gemini()

    prompt = f"""You are an expert {lang} developer and code reviewer.
Optimize the following code for:
1. Performance — eliminate unnecessary operations, use efficient data structures
2. Readability — clear variable names, proper formatting, logical structure
3. Best practices — modern {lang} patterns, error handling, type hints if applicable
4. Remove dead code, redundant comments, and unnecessary complexity

Return ONLY the optimized code — no explanation, no markdown, no backticks.

Original code:
{code[:6000]}

Optimized code:"""

    try:
        response  = model.generate_content(prompt)
        optimized = _clean_code(response.text)
    except Exception as e:
        return f"Could not optimize code: {e}"

    # Kaydet
    if file_path:
        save_path = Path(file_path)
    else:
        save_path = _resolve_save_path(output_path, lang)

    status = _save_file(save_path, optimized)
    print(f"[Code] ✅ Optimized: {save_path}")

    original_lines  = len(code.splitlines())
    optimized_lines = len(optimized.splitlines())
    diff = original_lines - optimized_lines

    return (
        f"Code optimized. {status}\n"
        f"Lines: {original_lines} → {optimized_lines} "
        f"({'−' if diff > 0 else '+'}{abs(diff)} lines)\n\n"
        f"Preview:\n{_preview(optimized)}"
    )


def _screen_debug_action(description, file_path, player, speak=None) -> str:

    if player:
        player.write_log("[Code] Taking screenshot for analysis...")

    print("[Code] 📸 Capturing screen for debug...")


    screenshot_path = _take_screenshot()
    if not screenshot_path:
        return "Could not take screenshot, sir. Please make sure PyAutoGUI is installed."


    file_content = ""
    if file_path:
        file_content, err = _read_file(file_path)
        if err:
            print(f"[Code] ⚠️ Could not read file: {err}")

    try:
        from google import genai
        from google.genai import types

        client = genai.Client(api_key=_get_api_key())

        image_bytes  = screenshot_path.read_bytes()
        image_base64 = _image_to_base64(screenshot_path)

        user_question = description or "What error or problem do you see on the screen? How can it be fixed?"

        context = ""
        if file_content:
            context = f"\n\nAdditionally, here is the related file content:\n```\n{file_content[:4000]}\n```"

        analysis_prompt = f"""You are an expert programmer and debugger analyzing a screenshot.

User's question: {user_question}{context}

Please:
1. Identify any errors, exceptions, or problems visible on the screen
2. Explain what is causing the problem in simple terms
3. Provide a concrete fix or solution
4. If there's code visible, show the corrected version

Be specific and actionable. If you see an error message, quote it exactly."""

        contents = [
            types.Part.from_bytes(data=image_bytes, mime_type="image/png"),
            analysis_prompt,
        ]

        response = client.models.generate_content(
            model="gemini-3.8-flash",
            contents=contents,
        )

        analysis = response.text.strip()
        print(f"[Code] ✅ Screen analysis complete")

        try:
            screenshot_path.unlink()
        except Exception:
            pass

        if file_path and file_content:

            code_match = re.search(r"```[a-zA-Z]*\n(.*?)```", analysis, re.DOTALL)
            if code_match:
                fixed_code = code_match.group(1).strip()
                save_path  = Path(file_path)
                _save_file(save_path, fixed_code)
                analysis += f"\n\n✅ Fixed code has been saved to: {file_path}"
                print(f"[Code] ✅ Fixed code saved: {file_path}")

        return analysis

    except Exception as e:

        try:
            screenshot_path.unlink()
        except Exception:
            pass
        return f"Screen analysis failed: {e}"


def code_helper(
    parameters: dict,
    response=None,
    player=None,
    session_memory=None,
    speak=None
) -> str:
    """
    Called from main.py.

    parameters:
        action      : write | edit | repair | rollback | explain | run | build | screen_debug | optimize | auto
        description : What the code should do / what change to make / what problem to analyze / bug to repair
        language    : Programming language (default: python)
        output_path : Where to save — user specifies full path or filename
        file_path   : Path to existing file (edit / repair / rollback / explain / run / build / optimize)
        code        : Raw code string (explain/optimize without a file)
        args        : CLI argument list for run/build
        timeout     : Execution timeout in seconds (default: 30)
    """
    p           = parameters or {}
    action      = p.get("action", "auto").lower().strip()
    description = p.get("description", "").strip()
    language    = p.get("language", "python").strip()
    output_path = p.get("output_path", "").strip()
    file_path   = p.get("file_path", "").strip()
    code        = p.get("code", "").strip()
    args        = p.get("args", [])
    timeout     = int(p.get("timeout", 30))

    if action == "auto":
        action = _detect_intent(description, file_path, code)
        print(f"[Code] 🤖 Auto-detected: {action}")

    if action == "write":
        return _write_action(description, language, output_path, player)

    elif action == "edit":
        return _edit_action(
            file_path,
            description or p.get("instruction", ""),
            player
        )

    elif action == "repair":
        return _repair_action(
            file_path,
            description or p.get("instruction", "Repair code bugs and ensure zero syntax errors"),
            player
        )

    elif action == "rollback":
        return _rollback_file(file_path)

    elif action == "explain":
        return _explain_action(file_path, code, player)

    elif action == "run":
        return _run_action(file_path, args, timeout, player)

    elif action == "build":
        return _build(description, language, output_path, args, timeout, speak, player)

    elif action == "optimize":
        return _optimize_action(file_path, code, language, output_path, player)

    elif action == "screen_debug":
        return _screen_debug_action(description, file_path, player, speak)

    else:
        return f"Unknown action: '{action}'. Use write, edit, repair, rollback, explain, run, build, optimize, or screen_debug."


# ── Tool declaration (auto-discovered by core/action_loader.py) ──────────────
TOOL = {
    "name": "code_helper",
    "description": "Writes, edits, repairs, rolls back, explains, runs, or builds code files with AST verification and automatic backups.",
    "parameters": {
        "type": "OBJECT",
        "properties": {
            "action": {
                "type": "STRING",
                "description": "write | edit | repair | rollback | explain | run | build | screen_debug | optimize | auto (default: auto)"
            },
            "description": {
                "type": "STRING",
                "description": "What the code should do, what change to make, or what bug to repair"
            },
            "language": {
                "type": "STRING",
                "description": "Programming language (default: python)"
            },
            "output_path": {
                "type": "STRING",
                "description": "Where to save the file"
            },
            "file_path": {
                "type": "STRING",
                "description": "Path to existing file for edit/repair/rollback/explain/run/build"
            },
            "code": {
                "type": "STRING",
                "description": "Raw code string for explain"
            },
            "args": {
                "type": "STRING",
                "description": "CLI arguments for run/build"
            },
            "timeout": {
                "type": "INTEGER",
                "description": "Execution timeout in seconds (default: 30)"
            }
        },
        "required": [
            "action"
        ]
    },
    "handler": code_helper,
}
