"""Line coverage for the Python files, with no extra packages (uses the standard trace module).
Run from the project folder: python tests/py_coverage.py"""
import os
import sys
import trace
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FILES = ["build_roads.py", "safer_route.py"]
sys.path.insert(0, ROOT)


def main():
    tracer = trace.Trace(count=1, trace=0, ignoredirs=[sys.prefix, sys.exec_prefix])
    suite = unittest.defaultTestLoader.discover(os.path.join(ROOT, "tests"), pattern="test_*.py")

    def run():
        # re-import under the tracer so module-level lines (imports, constants, defs) count
        import importlib
        import build_roads
        import safer_route
        importlib.reload(safer_route)
        importlib.reload(build_roads)
        with open(os.devnull, "w") as devnull:
            return unittest.TextTestRunner(verbosity=0, stream=devnull).run(suite)

    result = tracer.runfunc(run)
    counts = tracer.results().counts
    total_hit = total_lines = 0
    print(f"{'file':<16} {'lines':>6} {'hit':>6} {'cover':>7}  missed lines")
    for name in FILES:
        path = os.path.join(ROOT, name)
        lines = set(trace._find_executable_linenos(path))
        # the "if __name__ == '__main__'" call is never run under tests
        src = open(path, encoding="utf-8").read().splitlines()
        lines = {n for n in lines if "__main__" not in src[n - 1] and src[n - 1].strip() != "main()"}
        hit = {ln for (f, ln), c in counts.items() if os.path.abspath(f) == path and c}
        missed = sorted(lines - hit)
        total_hit += len(lines) - len(missed)
        total_lines += len(lines)
        print(f"{name:<16} {len(lines):>6} {len(lines) - len(missed):>6} {100 * (1 - len(missed) / len(lines)):>6.1f}%  {missed}")
    print(f"{'all':<16} {total_lines:>6} {total_hit:>6} {100 * total_hit / total_lines:>6.1f}%")
    print(f"tests run: {result.testsRun}, failures: {len(result.failures)}, errors: {len(result.errors)}")
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    sys.exit(main())
