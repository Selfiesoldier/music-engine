const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const https = require('https');
const http = require('http');

// URL for official pre-compiled standalone CPython 3.11 for Linux x86_64
const STANDALONE_PYTHON_LINUX_URL =
    'https://github.com/astral-sh/python-build-standalone/releases/download/20241016/cpython-3.11.10+20241016-x86_64-unknown-linux-gnu-install_only.tar.gz';

class PythonRuntime {
    static getPythonBinary(baseDir = process.cwd()) {
        if (process.env.PYTHON_BIN) {
            return process.env.PYTHON_BIN;
        }

        if (process.platform === 'win32') {
            return 'python';
        }

        // 1. Prefer local standalone Python in ./python/bin/python3 if it exists
        const localPython = path.join(baseDir, 'python', 'bin', 'python3');
        if (fs.existsSync(localPython)) {
            return localPython;
        }

        // 2. Check if system python3 has pip
        try {
            execSync('python3 -m pip --version', { stdio: 'ignore' });
            return 'python3';
        } catch (_) {}

        return localPython;
    }

    static isPythonAvailable(baseDir = process.cwd()) {
        const bin = PythonRuntime.getPythonBinary(baseDir);
        try {
            execSync(`"${bin}" --version`, { stdio: 'ignore' });
            return true;
        } catch (_) {
            return false;
        }
    }

    static async ensureRuntime(baseDir = process.cwd(), requirementsPath = null) {
        console.log('[PythonRuntime] Checking Python environment...');

        const isWin = process.platform === 'win32';
        const localPythonDir = path.join(baseDir, 'python');
        const localPythonBin = path.join(localPythonDir, 'bin', 'python3');
        const localPipBin = path.join(localPythonDir, 'bin', 'pip');

        let pythonBin = PythonRuntime.getPythonBinary(baseDir);
        let needsStandalone = false;

        if (isWin) {
            try {
                const ver = execSync('python --version', { encoding: 'utf-8' }).trim();
                console.log(`[PythonRuntime] Host system Python detected: ${ver}`);
                return pythonBin;
            } catch (err) {
                console.warn('[PythonRuntime] Windows python check:', err.message);
                return 'python';
            }
        }

        // Linux check: Verify both python3 AND pip are working
        if (fs.existsSync(localPythonBin)) {
            try {
                const ver = execSync(`"${localPythonBin}" --version`, { encoding: 'utf-8' }).trim();
                console.log(`[PythonRuntime] Using standalone Python: ${ver}`);
                pythonBin = localPythonBin;
            } catch (_) {
                needsStandalone = true;
            }
        } else {
            try {
                // Must have both python3 AND pip
                execSync('python3 -m pip --version', { stdio: 'ignore' });
                console.log('[PythonRuntime] Host system Python & Pip verified.');
            } catch (_) {
                console.log('[PythonRuntime] ⚠️ Host system Python is missing pip or incomplete. Switching to Standalone Python...');
                needsStandalone = true;
            }
        }

        if (needsStandalone) {
            console.log('[PythonRuntime] ⬇️ Downloading Standalone Portable Python 3.11 with Pip built-in...');

            const tarPath = path.join(baseDir, 'python-standalone.tar.gz');
            await PythonRuntime._downloadFile(STANDALONE_PYTHON_LINUX_URL, tarPath);

            console.log('[PythonRuntime] 📦 Extracting Standalone Python into ./python...');
            if (!fs.existsSync(localPythonDir)) {
                fs.mkdirSync(localPythonDir, { recursive: true });
            }

            try {
                execSync(`tar -xzf "${tarPath}" -C "${baseDir}"`, { stdio: 'inherit' });
            } catch (e) {
                execSync(`tar -xf "${tarPath}" -C "${baseDir}"`, { stdio: 'inherit' });
            }

            try { fs.unlinkSync(tarPath); } catch (_) {}

            if (fs.existsSync(localPythonBin)) {
                try { fs.chmodSync(localPythonBin, 0o755); } catch (_) {}
                if (fs.existsSync(localPipBin)) {
                    try { fs.chmodSync(localPipBin, 0o755); } catch (_) {}
                }
                const ver = execSync(`"${localPythonBin}" --version`, { encoding: 'utf-8' }).trim();
                console.log(`[PythonRuntime] ✅ Standalone Python successfully installed: ${ver}`);
                pythonBin = localPythonBin;
            } else {
                throw new Error(`Failed to locate python binary at ${localPythonBin} after extraction.`);
            }
        }

        const reqs = requirementsPath || path.join(baseDir, 'musicbot', 'requirements.txt');
        if (fs.existsSync(reqs)) {
            const installedFlag = path.join(localPythonDir, '.deps_installed');

            if (!fs.existsSync(installedFlag)) {
                console.log(`[PythonRuntime] 📦 Installing Python requirements from ${reqs}...`);
                try {
                    execSync(`"${pythonBin}" -m pip install --no-cache-dir -r "${reqs}"`, {
                        stdio: 'inherit',
                        env: {
                            ...process.env,
                            PATH: `${path.join(localPythonDir, 'bin')}:${process.env.PATH || ''}`
                        }
                    });
                    if (fs.existsSync(localPythonDir)) {
                        fs.writeFileSync(installedFlag, new Date().toISOString(), 'utf-8');
                    }
                    console.log('[PythonRuntime] ✅ Python dependencies installed successfully.');
                } catch (pipErr) {
                    console.error('[PythonRuntime] ⚠️ Pip install error:', pipErr.message);
                }
            } else {
                console.log('[PythonRuntime] ✅ Python dependencies already satisfied (cached).');
            }
        }

        return pythonBin;
    }

    static _downloadFile(url, destPath) {
        return new Promise((resolve, reject) => {
            const follow = (curUrl) => {
                const client = curUrl.startsWith('https') ? https : http;
                client.get(curUrl, (res) => {
                    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                        return follow(res.headers.location);
                    }
                    if (res.statusCode !== 200) {
                        return reject(new Error(`Failed to download: HTTP ${res.statusCode}`));
                    }
                    const totalBytes = parseInt(res.headers['content-length'] || '0', 10);
                    let downloadedBytes = 0;
                    let lastPercent = 0;

                    const fileStream = fs.createWriteStream(destPath);
                    res.on('data', (chunk) => {
                        downloadedBytes += chunk.length;
                        if (totalBytes > 0) {
                            const percent = Math.floor((downloadedBytes / totalBytes) * 100);
                            if (percent - lastPercent >= 20 || percent === 100) {
                                console.log(`[PythonRuntime] Download progress: ${percent}% (${(downloadedBytes / (1024 * 1024)).toFixed(1)} MB / ${(totalBytes / (1024 * 1024)).toFixed(1)} MB)`);
                                lastPercent = percent;
                            }
                        }
                    });

                    res.pipe(fileStream);
                    fileStream.on('finish', () => {
                        fileStream.close(() => resolve());
                    });
                    fileStream.on('error', (err) => {
                        try { fs.unlinkSync(destPath); } catch (_) {}
                        reject(err);
                    });
                }).on('error', (err) => {
                    try { fs.unlinkSync(destPath); } catch (_) {}
                    reject(err);
                });
            };
            follow(url);
        });
    }
}

module.exports = PythonRuntime;
