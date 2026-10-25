import { describe, expect, test } from 'bun:test'
import { cameThroughTailscaleServe, tailnetAudience } from './tailnet-audience'

// #2166: who may use "Ask this session" in a `--tailscale` session. The
// failure guarded: a request through `tailscale serve` reads as local (and so
// skips the owner check), or a login that is not the owner reads as the owner.

const OWNER = 'owner@example.com'
const served = (extra: Record<string, string> = {}) => new Headers({ 'x-forwarded-for': '100.64.0.7', ...extra })

describe('tailnetAudience', () => {
  test('no mark of serve is local, whatever Host or login a client claims', () => {
    expect(tailnetAudience(new Headers({ host: '127.0.0.1:4000' }), OWNER)).toBe('local')
    expect(tailnetAudience(new Headers({ 'x-forwarded-for': '127.0.0.1, ::1' }), OWNER)).toBe('local')
  })

  test('the owner through serve, compared case-insensitively and RFC 2047 decoded', () => {
    expect(tailnetAudience(served({ 'tailscale-user-login': 'Owner@Example.com', 'tailscale-headers-info': 'https://tailscale.com/s/serve-headers' }), OWNER)).toBe('owner')
    expect(tailnetAudience(served({ 'tailscale-user-login': '=?utf-8?q?J=C3=BCrgen@example.com?=' }), 'jürgen@example.com')).toBe('owner')
  })

  test('another login, a tagged device, funnel, an unreadable owner, a malformed login: peer', () => {
    expect(tailnetAudience(served({ 'tailscale-user-login': 'guest@example.com' }), OWNER)).toBe('peer')
    expect(tailnetAudience(served(), OWNER)).toBe('peer')
    expect(tailnetAudience(served({ 'tailscale-user-login': OWNER, 'tailscale-funnel-request': '?1' }), OWNER)).toBe('peer')
    expect(tailnetAudience(served({ 'tailscale-user-login': OWNER }), null)).toBe('peer')
    expect(tailnetAudience(served({ 'tailscale-user-login': '=?utf-8?q?=ZZ?=' }), OWNER)).toBe('peer')
  })

  test('any one of serve\'s headers marks a request, even without X-Forwarded-For', () => {
    for (const name of ['tailscale-user-login', 'tailscale-headers-info', 'tailscale-funnel-request']) {
      expect(cameThroughTailscaleServe(new Headers({ [name]: 'x' }))).toBe(true)
    }
    expect(cameThroughTailscaleServe(new Headers({ 'x-forwarded-for': '' }))).toBe(true)
    expect(cameThroughTailscaleServe(new Headers())).toBe(false)
  })
})
