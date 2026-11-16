#!/usr/bin/env python3
"""读取任意进程的内核态信息（macOS 无 ps/top 权限时的替代方案）。
用法: python3 proc-diag.py <pid> [pid...] [--wait 3]
"""
import ctypes
import ctypes.util
import sys
import time

libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)

PROC_PIDTASKINFO = 4
PROC_PIDPATHINFO_MAXSIZE = 4096


class ProcTaskInfo(ctypes.Structure):
    _fields_ = [
        ("pti_virtual_size", ctypes.c_uint64),
        ("pti_resident_size", ctypes.c_uint64),
        ("pti_total_user", ctypes.c_uint64),
        ("pti_total_system", ctypes.c_uint64),
        ("pti_threads_user", ctypes.c_uint64),
        ("pti_threads_system", ctypes.c_uint64),
        ("pti_policy", ctypes.c_int32),
        ("pti_faults", ctypes.c_int32),
        ("pti_pageins", ctypes.c_int32),
        ("pti_cow_faults", ctypes.c_int32),
        ("pti_messages_sent", ctypes.c_int32),
        ("pti_messages_received", ctypes.c_int32),
        ("pti_syscalls_mach", ctypes.c_int32),
        ("pti_syscalls_unix", ctypes.c_int32),
        ("pti_csw", ctypes.c_int32),
        ("pti_threadnum", ctypes.c_int32),
        ("pti_numrunning", ctypes.c_int32),
        ("pti_priority", ctypes.c_int32),
    ]


def task_info(pid):
    info = ProcTaskInfo()
    n = libc.proc_pidinfo(pid, PROC_PIDTASKINFO, 0, ctypes.byref(info), ctypes.sizeof(info))
    if n <= 0:
        return None
    return info


def proc_path(pid):
    buf = ctypes.create_string_buffer(PROC_PIDPATHINFO_MAXSIZE)
    n = libc.proc_pidpath(pid, buf, PROC_PIDPATHINFO_MAXSIZE)
    return buf.value.decode() if n > 0 else "?"


def proc_name(pid):
    buf = ctypes.create_string_buffer(256)
    n = libc.proc_name(pid, buf, 256)
    return buf.value.decode() if n > 0 else "?"


def main():
    args = sys.argv[1:]
    wait = 3.0
    if "--wait" in args:
        i = args.index("--wait")
        wait = float(args[i + 1])
        del args[i:i + 2]
    pids = [int(a) for a in args]

    first = {}
    for pid in pids:
        t = task_info(pid)
        first[pid] = t
    time.sleep(wait)
    second = {}
    for pid in pids:
        second[pid] = task_info(pid)

    print(f"{'PID':>7}  {'CPU%':>6}  {'RSS(MB)':>8}  {'THR':>4}  {'RUN':>3}  {'CSW/s':>7}  {'NAME':<24} PATH")
    total_cpu = 0.0
    for pid in pids:
        a, b = first[pid], second[pid]
        if not a or not b:
            print(f"{pid:>7}  <不可读，进程可能已退出或无权限>")
            continue
        # 内核返回的时间单位是纳秒
        da = (b.pti_total_user - a.pti_total_user) + (b.pti_total_system - a.pti_total_system)
        cpu = (da / 1e9) / wait * 100.0
        total_cpu += cpu
        csw = (b.pti_csw - a.pti_csw) / wait
        print(
            f"{pid:>7}  {cpu:>6.1f}  {b.pti_resident_size/1048576:>8.1f}  "
            f"{b.pti_threadnum:>4}  {b.pti_numrunning:>3}  {csw:>7.1f}  "
            f"{proc_name(pid):<24} {proc_path(pid)}"
        )
    print(f"\n合计 CPU: {total_cpu:.1f}%   采样窗口: {wait}s")


if __name__ == "__main__":
    main()
