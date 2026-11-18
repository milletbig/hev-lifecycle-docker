#!/usr/bin/env python3
"""从标准输入读取登录口令，输出与服务端一致的 scrypt 散列。

用法：
    printf '%s' '你的密码' | python3 scripts/gen-password-hash.py
或交互输入：
    python3 scripts/gen-password-hash.py

输出示例：
    scrypt:16384:8:1:<salt-b64url>:<hash-b64url>
"""
import base64
import getpass
import hashlib
import os
import sys

N = 16384
R = 8
P = 1
KEYLEN = 64


def b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b'=').decode('ascii')


def main() -> int:
    if sys.stdin.isatty():
        password = getpass.getpass('请输入登录密码: ')
        confirm = getpass.getpass('请再次输入: ')
        if password != confirm:
            print('两次输入不一致', file=sys.stderr)
            return 1
    else:
        password = sys.stdin.readline().rstrip('\n')
    if not password:
        print('密码不能为空', file=sys.stderr)
        return 1
    salt = os.urandom(16)
    digest = hashlib.scrypt(password.encode('utf-8'), salt=salt, n=N, r=R, p=P, dklen=KEYLEN)
    print(f'scrypt:{N}:{R}:{P}:{b64url(salt)}:{b64url(digest)}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
