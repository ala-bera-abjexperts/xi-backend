"""Run with python3 scripts/test-deploy-backend.py; no server or network needed."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('deploy-backend.sh')


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.app = self.root / 'app'
        self.app.mkdir()
        self.git('init', '-b', 'main')
        self.git('config', 'user.email', 'release@example.test')
        self.git('config', 'user.name', 'Release Test')
        (self.app / '.gitignore').write_text('dist/\nnode_modules/\n.env\n')
        (self.app / 'revision').write_text('old')
        self.git('add', '.')
        self.git('commit', '-qm', 'Old release')
        self.old = self.git('rev-parse', 'HEAD').strip()
        self.git('clone', '--bare', str(self.app), str(self.root / 'origin'))
        self.git('remote', 'add', 'origin', str(self.root / 'origin'))
        (self.app / 'revision').write_text('new')
        self.git('commit', '-qam', 'New release')
        self.new = self.git('rev-parse', 'HEAD').strip()
        self.git('push', '-q', 'origin', 'main')
        self.git('reset', '--hard', self.old)
        for folder, file in [('dist', 'main.js'), ('node_modules', 'marker')]:
            (self.app / folder).mkdir()
            (self.app / folder / file).write_text('old')
        (self.app / '.env').write_text('PRESERVE_ME=yes')
        bin_dir = self.root / 'bin'
        bin_dir.mkdir()
        mocks = {
            'flock': 'exit "${LOCK_FAIL:-0}"',
            'sleep': 'exit 0',
            'mv': '''if [ "${MOVE_FAIL:-0}" = 1 ]; then
  case "$1" in */source/node_modules) exit 1;; esac
fi
exec /bin/mv "$@"''',
            'pnpm': '''echo "$1" >> "$CALLS"
if [ "$1" = install ]; then
  [ "${INSTALL_FAIL:-0}" = 0 ] || exit 1
  mkdir node_modules; cp revision node_modules/marker
else
  case "$NODE_OPTIONS" in *--max-old-space-size=3072*) ;; *) exit 2;; esac
  [ "${BUILD_FAIL:-0}" = 0 ] || exit 1
  mkdir dist; cp revision dist/main.js
fi''',
            'systemctl': '''echo "systemctl $1" >> "$CALLS"
if [ "$1" = restart ] && [ "${RESTART_FAIL:-0}" = 1 ] && [ "$(cat "$APP_DIR/dist/main.js")" = new ]; then exit 1; fi
exit 0''',
            'curl': '''[ "${HEALTH_FAIL:-0}" != all ] || exit 1
if [ "${HEALTH_FAIL:-0}" = new ] && [ "$(cat "$APP_DIR/dist/main.js")" = new ]; then exit 1; fi
exit 0''',
        }
        for name, body in mocks.items():
            p = bin_dir / name
            p.write_text('#!/usr/bin/env bash\nset -eu\n' + body + '\n')
            p.chmod(0o755)
        self.env = {**os.environ, 'PATH': f'{bin_dir}:{os.environ["PATH"]}',
                    'APP_DIR': str(self.app), 'LOG_FILE': str(self.root / 'deploy.log'),
                    'CALLS': str(self.root / 'calls')}

    def git(self, *args):
        return subprocess.check_output(['git', *args], cwd=self.app, stderr=subprocess.DEVNULL, text=True)

    def run_deploy(self, **env):
        result = subprocess.run(['bash', str(SCRIPT)], env={**self.env, **env}, capture_output=True, text=True)
        self.assertEqual((self.app / '.env').read_text(), 'PRESERVE_ME=yes')
        return result

    def assert_old(self):
        self.assertEqual(self.git('rev-parse', 'HEAD').strip(), self.old)
        self.assertEqual((self.app / 'dist/main.js').read_text(), 'old')
        self.assertEqual((self.app / 'node_modules/marker').read_text(), 'old')

    def test_success(self):
        r = self.run_deploy()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(self.git('rev-parse', 'HEAD').strip(), self.new)
        self.assertEqual((self.app / 'dist/main.js').read_text(), 'new')
        self.assertEqual((self.app / 'node_modules/marker').read_text(), 'new')
        self.assertFalse([p for p in self.root.glob('app.deploy.*') if p.is_dir()])

    def test_build_failure_leaves_live_release_untouched(self):
        r = self.run_deploy(BUILD_FAIL='1')
        self.assertNotEqual(r.returncode, 0)
        self.assert_old()
        self.assertNotIn('systemctl', (self.root / 'calls').read_text())

    def test_install_failure_leaves_live_release_untouched(self):
        self.assertNotEqual(self.run_deploy(INSTALL_FAIL='1').returncode, 0)
        self.assert_old()

    def test_health_failure_restores_without_rebuilding(self):
        r = self.run_deploy(HEALTH_FAIL='new')
        self.assertNotEqual(r.returncode, 0)
        self.assert_old()
        self.assertIn('ROLLBACK VERIFIED', r.stdout)
        self.assertEqual((self.root / 'calls').read_text().splitlines().count('build'), 1)

    def test_restart_failure_rolls_back(self):
        r = self.run_deploy(RESTART_FAIL='1')
        self.assertNotEqual(r.returncode, 0)
        self.assert_old()
        self.assertIn('ROLLBACK VERIFIED', r.stdout)

    def test_partial_artifact_switch_rolls_back(self):
        r = self.run_deploy(MOVE_FAIL='1')
        self.assertNotEqual(r.returncode, 0)
        self.assert_old()
        self.assertIn('ROLLBACK VERIFIED', r.stdout)

    def test_same_commit_unhealthy_does_not_skip_rebuild(self):
        self.git('push', '-q', '--force', 'origin', self.old + ':main')
        r = self.run_deploy(HEALTH_FAIL='all')
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual((self.root / 'calls').read_text().splitlines().count('build'), 1)

    def test_failed_rollback_is_reported_and_retained(self):
        r = self.run_deploy(HEALTH_FAIL='all')
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('ROLLBACK FAILED', r.stdout)
        self.assertNotIn('ROLLBACK VERIFIED', r.stdout)
        self.assertTrue([p for p in self.root.glob('app.deploy.*') if p.is_dir()])

    def test_healthy_same_commit_skips_build(self):
        self.git('push', '-q', '--force', 'origin', self.old + ':main')
        self.assertEqual(self.run_deploy().returncode, 0)
        self.assert_old()
        self.assertNotIn('build', (self.root / 'calls').read_text())

    def test_dirty_checkout_is_not_overwritten(self):
        (self.app / 'revision').write_text('local edit')
        self.assertNotEqual(self.run_deploy().returncode, 0)
        self.assertEqual((self.app / 'revision').read_text(), 'local edit')

    def test_lock_refuses_overlapping_deploy(self):
        self.assertNotEqual(self.run_deploy(LOCK_FAIL='1').returncode, 0)
        self.assert_old()


if __name__ == '__main__':
    unittest.main()
