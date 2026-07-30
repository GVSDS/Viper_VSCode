/*
 * realTempFile.test.ts
 *
 * Tests for RealTempFile temp directory behavior.
 */

import assert from 'assert';

// The tmp package's exports are not always configurable, which can make jest.spyOn fail.
// Mock the module instead so we can reliably simulate failures.
jest.mock('tmp', () => {
    const actual = jest.requireActual<typeof import('tmp')>('tmp');
    return {
        ...actual,
        dirSync: jest.fn(),
    };
});

import * as tmp from 'tmp';

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

import { normalizeSlashes } from '../common/pathUtils';
import { RealTempFile } from '../common/realFileSystem';

test('RealTempFile surfaces ENOENT with guidance to set VIPER_TMPDIR', () => {
    const old = process.env.VIPER_TMPDIR;
    delete process.env.VIPER_TMPDIR;

    const dirSyncMock = tmp.dirSync as unknown as jest.Mock;
    const enoent = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException;
    enoent.code = 'ENOENT';
    dirSyncMock.mockImplementationOnce(() => {
        throw enoent;
    });

    const tempFile = new RealTempFile();
    try {
        assert.throws(() => tempFile.tmpdir(), /VIPER_TMPDIR/);
        assert.equal(dirSyncMock.mock.calls.length, 1);
        assert.deepEqual(dirSyncMock.mock.calls[0][0], { prefix: 'viper' });
    } finally {
        tempFile.dispose();
        dirSyncMock.mockReset();
        process.env.VIPER_TMPDIR = old;
    }
});

test('RealTempFile honors VIPER_TMPDIR when set', () => {
    const old = process.env.VIPER_TMPDIR;
    const configuredTmpRoot = path.join(os.tmpdir(), `viper-tmp-root-test-${Date.now()}`);
    process.env.VIPER_TMPDIR = configuredTmpRoot;

    const expectedTmpDir = normalizeSlashes('/tmp/viper-configured');

    const dirSyncMock = tmp.dirSync as unknown as jest.Mock;
    dirSyncMock.mockImplementationOnce(() => ({ name: expectedTmpDir, removeCallback: () => {} }));

    const tempFile = new RealTempFile();
    try {
        const dirUri = tempFile.tmpdir();
        assert.equal(normalizeSlashes(dirUri.getFilePath()), expectedTmpDir);
        assert.equal(dirSyncMock.mock.calls.length, 1);
        assert.equal(dirSyncMock.mock.calls[0][0].prefix, 'viper');
        assert.equal(dirSyncMock.mock.calls[0][0].tmpdir, configuredTmpRoot);
        assert(fs.existsSync(configuredTmpRoot));
    } finally {
        tempFile.dispose();
        dirSyncMock.mockReset();
        fs.rmSync(configuredTmpRoot, { recursive: true, force: true });
        process.env.VIPER_TMPDIR = old;
    }
});

test('RealTempFile falls back to default when VIPER_TMPDIR cannot be used', () => {
    const old = process.env.VIPER_TMPDIR;
    const configuredTmpRoot = path.join(os.tmpdir(), `viper-tmp-root-test-${Date.now()}`);
    process.env.VIPER_TMPDIR = configuredTmpRoot;

    const expectedTmpDir = normalizeSlashes('/tmp/viper-default-after-config-failure');

    const dirSyncMock = tmp.dirSync as unknown as jest.Mock;
    const eacces = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
    eacces.code = 'EACCES';

    dirSyncMock
        .mockImplementationOnce(() => {
            throw eacces;
        })
        .mockImplementationOnce(() => ({ name: expectedTmpDir, removeCallback: () => {} }));

    const tempFile = new RealTempFile();
    try {
        const dirUri = tempFile.tmpdir();
        assert.equal(normalizeSlashes(dirUri.getFilePath()), expectedTmpDir);
        assert.equal(dirSyncMock.mock.calls.length, 2);
        assert.equal(dirSyncMock.mock.calls[0][0].tmpdir, configuredTmpRoot);
        assert.deepEqual(dirSyncMock.mock.calls[1][0], { prefix: 'viper' });
        assert(fs.existsSync(configuredTmpRoot));
    } finally {
        tempFile.dispose();
        dirSyncMock.mockReset();
        fs.rmSync(configuredTmpRoot, { recursive: true, force: true });
        process.env.VIPER_TMPDIR = old;
    }
});

test('RealTempFile does not attempt fallback root on non-ENOENT error', () => {
    const old = process.env.VIPER_TMPDIR;
    delete process.env.VIPER_TMPDIR;

    const dirSyncMock = tmp.dirSync as unknown as jest.Mock;
    const eacces = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
    eacces.code = 'EACCES';
    dirSyncMock.mockImplementationOnce(() => {
        throw eacces;
    });

    const tempFile = new RealTempFile();
    try {
        assert.throws(() => tempFile.tmpdir(), /Failed to create a temporary directory for Viper/);
        assert.equal(dirSyncMock.mock.calls.length, 1);
        assert.deepEqual(dirSyncMock.mock.calls[0][0], { prefix: 'viper' });
    } finally {
        tempFile.dispose();
        dirSyncMock.mockReset();
        process.env.VIPER_TMPDIR = old;
    }
});
