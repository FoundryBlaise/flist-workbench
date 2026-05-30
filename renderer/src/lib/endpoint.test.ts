import { describe, it, expect } from 'vitest'
import { categoriseEndpoint, endpointConsentKey } from './endpoint'

describe('categoriseEndpoint', () => {
  it('returns unknown for blank / malformed', () => {
    expect(categoriseEndpoint('')).toBe('unknown')
    expect(categoriseEndpoint('   ')).toBe('unknown')
    expect(categoriseEndpoint('not a url')).toBe('unknown')
    expect(categoriseEndpoint('http://')).toBe('unknown')
  })

  it('recognises loopback hosts as local', () => {
    expect(categoriseEndpoint('http://localhost:1234/v1')).toBe('local')
    expect(categoriseEndpoint('http://127.0.0.1:11434')).toBe('local')
    expect(categoriseEndpoint('http://0.0.0.0:8080')).toBe('local')
    expect(categoriseEndpoint('http://[::1]:8080')).toBe('local')
    expect(categoriseEndpoint('http://host.docker.internal:1234/v1')).toBe('local')
  })

  it('recognises mDNS / link-local / lan-style hosts as local', () => {
    expect(categoriseEndpoint('http://my-rig.local:1234/v1')).toBe('local')
    expect(categoriseEndpoint('http://nas.lan:8080')).toBe('local')
    expect(categoriseEndpoint('http://lmstudio-box:1234/v1')).toBe('local')
  })

  it('recognises RFC1918 IPv4 ranges as local', () => {
    expect(categoriseEndpoint('http://192.168.1.50:1234/v1')).toBe('local')
    expect(categoriseEndpoint('http://10.0.0.5:11434')).toBe('local')
    expect(categoriseEndpoint('http://172.16.0.1:8080')).toBe('local')
    expect(categoriseEndpoint('http://172.31.255.254:8080')).toBe('local')
    expect(categoriseEndpoint('http://169.254.1.1:8080')).toBe('local')
  })

  it('recognises non-private IPv4 as remote', () => {
    expect(categoriseEndpoint('http://8.8.8.8:443')).toBe('remote')
    expect(categoriseEndpoint('http://172.32.0.1:80')).toBe('remote')
    expect(categoriseEndpoint('http://172.15.0.1:80')).toBe('remote')
  })

  it('recognises public DNS hostnames as remote', () => {
    expect(categoriseEndpoint('https://api.openai.com/v1')).toBe('remote')
    expect(categoriseEndpoint('https://api.anthropic.com/v1')).toBe('remote')
    expect(categoriseEndpoint('http://my-rig.example.net:8080')).toBe('remote')
  })
})

describe('endpointConsentKey', () => {
  it('keys by host:port — path / scheme / case do not change the key', () => {
    const a = endpointConsentKey('https://API.OpenAI.com/v1/chat')
    const b = endpointConsentKey('https://api.openai.com:443/v1')
    // 443 default is dropped by URL.host, so these should NOT match —
    // intentional: an explicit port targets a different listener.
    expect(a).toBe('workbench.remoteEndpointAck.api.openai.com')
    expect(b).toBe('workbench.remoteEndpointAck.api.openai.com')
  })

  it('returns null for blank or malformed urls', () => {
    expect(endpointConsentKey('')).toBeNull()
    expect(endpointConsentKey('not a url')).toBeNull()
  })
})
