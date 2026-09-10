import test from 'node:test';
import assert from 'node:assert/strict';
import { assertLocalDockerEndpoint } from '../lib/launcher.mjs';

test('launcher permits only known local Docker transports without revealing rejected endpoints', () => {
  for (const endpoint of ['unix:///var/run/docker.sock', 'npipe:////./pipe/dockerDesktopLinuxEngine', 'tcp://localhost:2375', 'tcp://127.0.0.1:2375', 'tcp://[::1]:2375']) {
    assert.doesNotThrow(() => assertLocalDockerEndpoint(endpoint));
  }
  for (const endpoint of ['', 'ssh://test-user@remote.example', 'tcp://remote.example:2375', 'npipe:////remote.example/pipe/docker_engine', 'unix://remote.example/run/docker.sock', 'tcp://test-secret@localhost:2375', 'tcp://localhost:2375?token=test-secret']) {
    assert.throws(() => assertLocalDockerEndpoint(endpoint), error => !error.message.includes('test-secret') && !error.message.includes('remote.example'));
  }
});
