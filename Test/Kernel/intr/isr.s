.section .bss
.comm _per_cpu, 32, 8
.comm _proc_mgr, 8192, 16
.comm _proc_mgr_ptr, 8, 8
.comm _saved_cr3, 8, 8
.comm _yield_cnt, 4, 4
.comm _yield_lock, 4, 4
.comm _fs_lock, 4, 4
.comm _fault_rip, 8, 8
.comm _fault_err, 8, 8

.section .text
.intel_syntax noprefix

.globl isr_default
isr_default:
    push rax
    push rdx
    mov al, 0x20
    out 0xA0, al
    out 0x20, al
    pop rdx
    pop rax
    iretq

# =============================================================================
# ISR macros with Ring 3 support
#
# When CPU takes interrupt/exception:
#   From Ring 0: pushes RFLAGS, CS, RIP  (3 qwords)
#   From Ring 3: pushes SS, RSP, RFLAGS, CS, RIP  (5 qwords)
#   CPU also switches to TSS RSP0 stack when coming from Ring 3.
#
# Strategy:
# 1. Check CS RPL to determine if from Ring 3
# 2. If from Ring 3: swapgs (make gs: point to per_cpu), save user RSP
# 3. Save full interrupt frame into registers
# 4. Re-push in uniform format with is_user flag
# 5. Call handler
# 6. On return, rebuild correct iretq frame based on is_user
# 7. If returning to Ring 3: swapgs back
# =============================================================================

.macro ISR_NOERR num
.globl isr\num
isr\num:
    # Check CS RPL to determine if from Ring 3
    mov rax, [rsp + 8]       # CS from interrupt frame
    test al, 3               # RPL bits: 0 = Ring 0, 3 = Ring 3
    jnz isr\num\()_from_user

isr\num\()_from_kernel:
    # From Ring 0: no swapgs needed, already on kernel stack
    mov r8, [rsp]            # RIP
    mov r9, [rsp + 8]        # CS
    mov r10, [rsp + 16]      # RFLAGS
    xor r11, r11             # SS = 0
    xor rax, rax             # RSP = 0
    add rsp, 24              # remove the 3 CPU-pushed qwords
    jmp isr\num\()_frame_ready

isr\num\()_from_user:
    # From Ring 3: swapgs to make gs: accessible, CPU already switched to TSS RSP0
    swapgs
    # Save user RSP to per_cpu.user_rsp (gs:[0x0])
    # Note: CPU has already switched RSP to TSS RSP0, so the user RSP is on this stack
    mov r8, [rsp]            # RIP
    mov r9, [rsp + 8]        # CS
    mov r10, [rsp + 16]      # RFLAGS
    mov rax, [rsp + 24]      # RSP (user)
    mov r11, [rsp + 32]      # SS (user)
    # Save user RSP to per_cpu for potential later use
    mov gs:[0x0], rax
    add rsp, 40              # remove the 5 CPU-pushed qwords

isr\num\()_frame_ready:
    # r8=RIP, r9=CS, r10=RFLAGS, rax=RSP(0 if kernel), r11=SS(0 if kernel)
    # Build uniform frame on stack for iretq later
    push r11                 # SS
    push rax                 # RSP
    push r10                 # RFLAGS
    push r9                  # CS
    push r8                  # RIP

    # Push is_user flag (1 if from Ring 3, 0 if from Ring 0)
    xor ecx, ecx
    test r9b, 3              # test CS RPL
    setnz cl                 # cl = 1 if from Ring 3
    push rcx                 # is_user

    # Push all general-purpose registers
    push rax
    push rbx
    push rdx
    push rsi
    push rdi
    push rbp
    push r8
    push r9
    push r10
    push r11
    push r12
    push r13
    push r14
    push r15
    # Save faulting RIP and error code for debug
    mov [_fault_rip], r8
    mov [_fault_err], rdx
    call isr\num\()_handler
    pop r15
    pop r14
    pop r13
    pop r12
    pop r11
    pop r10
    pop r9
    pop r8
    pop rbp
    pop rdi
    pop rsi
    pop rdx
    pop rbx
    pop rax

    # Pop is_user flag
    pop rcx                  # is_user

    # Pop the uniform frame into registers
    pop r8                   # RIP
    pop r9                   # CS
    pop r10                  # RFLAGS
    pop rax                  # RSP (user)
    pop r11                  # SS (user)

    test rcx, rcx
    jnz isr\num\()_ret_user

isr\num\()_ret_kernel:
    # Return to Ring 0: push RFLAGS, CS, RIP only
    push r10                 # RFLAGS
    push r9                  # CS
    push r8                  # RIP
    iretq

isr\num\()_ret_user:
    # Return to Ring 3: swapgs back, then push SS, RSP, RFLAGS, CS, RIP
    swapgs
    # DIAG+FIX: if RFLAGS.NT (bit 14) is set, iretq performs hardware task-return
    # which loads TSS selector 0x28 -> #GP(err=0x28). Detect and clear it.
    test r10, 0x4000
    jz 1f
    btr r10, 14
    mov dx, 0x3F8
    mov al, 0x4E            # 'N' marker = NT was set (now cleared)
    out dx, al
1:
    cmp r9, 0x1B
    jne 8f
    cmp r11, 0x23
    jne 8f
    push r11                 # SS
    push rax                 # RSP
    push r10                 # RFLAGS
    push r9                  # CS
    push r8                  # RIP
    iretq
8:
    mov dx, 0x3F8
    mov al, 0x42             # 'B' = bad CS/SS
    out dx, al
    mov al, 0x20             # space
    out dx, al
    # Output CS (r9) low byte as 2 hex digits
    mov rcx, r9
    mov rax, rcx
    shr rax, 4
    and rax, 0xF
    add al, 0x30
    cmp al, 0x39
    jle 2f
    add al, 7
2:
    out dx, al
    mov rax, rcx
    and rax, 0xF
    add al, 0x30
    cmp al, 0x39
    jle 3f
    add al, 7
3:
    out dx, al
    mov al, 0x20             # space
    out dx, al
    # Output SS (r11) low byte as 2 hex digits
    mov rcx, r11
    mov rax, rcx
    shr rax, 4
    and rax, 0xF
    add al, 0x30
    cmp al, 0x39
    jle 4f
    add al, 7
4:
    out dx, al
    mov rax, rcx
    and rax, 0xF
    add al, 0x30
    cmp al, 0x39
    jle 5f
    add al, 7
5:
    out dx, al
    mov al, 0x0A             # newline
    out dx, al
    cli
7:
    hlt
    jmp 7b
.endm

.macro ISR_ERR num
.globl isr\num
isr\num:
    # Stack at entry (with error code):
    #   From Ring 0: [rsp]=error_code, [rsp+8]=RIP, [rsp+16]=CS, [rsp+24]=RFLAGS
    #   From Ring 3: [rsp]=error_code, [rsp+8]=RIP, [rsp+16]=CS, [rsp+24]=RFLAGS, [rsp+32]=RSP, [rsp+40]=SS

    # Check CS RPL
    mov rax, [rsp + 16]      # CS from interrupt frame
    test al, 3
    jnz isr\num\()_from_user

isr\num\()_from_kernel:
    # From Ring 0: no swapgs needed
    mov rdx, [rsp]           # error_code
    mov r8, [rsp + 8]        # RIP
    mov r9, [rsp + 16]       # CS
    mov r10, [rsp + 24]      # RFLAGS
    xor r11, r11             # SS = 0
    xor rax, rax             # RSP = 0
    add rsp, 32              # remove 4 CPU-pushed qwords (error + 3 frame)
    jmp isr\num\()_frame_ready

isr\num\()_from_user:
    # From Ring 3: swapgs, CPU already on TSS RSP0
    swapgs
    mov rdx, [rsp]           # error_code
    mov r8, [rsp + 8]        # RIP
    mov r9, [rsp + 16]       # CS
    mov r10, [rsp + 24]      # RFLAGS
    mov rax, [rsp + 32]      # RSP (user)
    mov r11, [rsp + 40]      # SS (user)
    mov gs:[0x0], rax        # save user RSP
    add rsp, 48              # remove 6 CPU-pushed qwords (error + 5 frame)

isr\num\()_frame_ready:
    # rdx=error_code, r8=RIP, r9=CS, r10=RFLAGS, rax=RSP, r11=SS
    # Build uniform frame on stack
    push r11                 # SS
    push rax                 # RSP
    push r10                 # RFLAGS
    push r9                  # CS
    push r8                  # RIP
    push rdx                 # error_code

    # Push is_user flag
    xor ecx, ecx
    test r9b, 3
    setnz cl
    push rcx                 # is_user

    # Push all general-purpose registers
    push rax
    push rbx
    push rsi
    push rdi
    push rbp
    push r8
    push r9
    push r10
    push r11
    push r12
    push r13
    push r14
    push r15
    # Save faulting RIP and error code for debug
    mov [_fault_rip], r8
    mov [_fault_err], rdx
    call isr\num\()_handler
    pop r15
    pop r14
    pop r13
    pop r12
    pop r11
    pop r10
    pop r9
    pop r8
    pop rbp
    pop rdi
    pop rsi
    pop rbx
    pop rax

    # Pop is_user flag
    pop rcx                  # is_user
    add rsp, 8               # skip error_code (handler already consumed it)
    pop r8                   # RIP
    pop r9                   # CS
    pop r10                  # RFLAGS
    pop rax                  # RSP (user)
    pop r11                  # SS (user)

    test rcx, rcx
    jnz isr\num\()_ret_user

isr\num\()_ret_kernel:
    push r10                 # RFLAGS
    push r9                  # CS
    push r8                  # RIP
    iretq

isr\num\()_ret_user:
    swapgs
    push r11                 # SS
    push rax                 # RSP
    push r10                 # RFLAGS
    push r9                  # CS
    push r8                  # RIP
    iretq
.endm

ISR_NOERR 0
ISR_NOERR 1
ISR_NOERR 2
ISR_NOERR 3
ISR_NOERR 4
ISR_NOERR 5
ISR_NOERR 6
ISR_NOERR 7
ISR_ERR 8
ISR_NOERR 9
ISR_ERR 10
ISR_ERR 11
ISR_ERR 12
ISR_ERR 13
ISR_ERR 14
ISR_NOERR 15
ISR_NOERR 16
ISR_ERR 17
ISR_NOERR 18
ISR_NOERR 19
ISR_NOERR 20
ISR_NOERR 21
ISR_NOERR 22
ISR_NOERR 23
ISR_NOERR 24
ISR_NOERR 25
ISR_NOERR 26
ISR_NOERR 27
ISR_NOERR 28
ISR_NOERR 29
ISR_NOERR 30
ISR_NOERR 31
ISR_NOERR 32
ISR_NOERR 33
ISR_NOERR 34
ISR_NOERR 35
ISR_NOERR 36
ISR_NOERR 37
ISR_NOERR 38
ISR_NOERR 39
ISR_NOERR 40
ISR_NOERR 41
ISR_NOERR 42
ISR_NOERR 43
ISR_NOERR 44
ISR_NOERR 45
ISR_NOERR 46
ISR_NOERR 47

.globl syscall_entry
syscall_entry:
    mov rax, rsp
    shr rax, 47
    test rax, rax
    jnz syscall_from_kernel
syscall_from_user:
    swapgs
    mov gs:[0x0], rsp
    mov rsp, gs:[0x8]
    jmp syscall_common
syscall_from_kernel:
syscall_common:
    push rcx
    push r11
    push rbx
    push rdx
    push rsi
    push rdi
    push rbp
    push r8
    push r9
    push r10
    push r12
    push r13
    push r14
    push r15
    mov rbp, rsp
    and rsp, ~15
    push r9
    mov r9, r8
    mov r8, r10
    mov rcx, rdx
    mov rdx, rsi
    mov rsi, rdi
    mov rdi, rax
    call syscall_handler
    add rsp, 8
    mov rsp, rbp
    pop r15
    pop r14
    pop r13
    pop r12
    pop r10
    pop r9
    pop r8
    pop rbp
    pop rdi
    pop rsi
    pop rdx
    pop rbx
    pop r11
    pop rcx
    mov rax, rcx
    shr rax, 47
    test rax, rax
    jnz syscall_ret_kernel
syscall_ret_user:
    mov rsp, gs:[0x0]
    swapgs
    push r11
    popfq
    sysretq
syscall_ret_kernel:
    push r11
    popfq
    jmp rcx

# =============================================================================
# ISR 0x80 - int 0x80 syscall handler for user-mode ELF apps
#
# int 0x80 calling convention (ViperOS):
#   rax = syscall number
#   rbx = arg1
#   rcx = arg2
#   rdx = arg3
#   r10 = arg4
#
# Translated to syscall_handler calling convention:
#   rdi = n (syscall number)
#   rsi = arg1
#   rdx = arg2
#   rcx = arg3
#   r8  = arg4
#   r9  = arg5 (0)
#   stack = arg6 (0)
#
# Return value in rax.
# =============================================================================
.globl isr80
isr80:
    # Check CS RPL to determine if from Ring 3
    mov rax, [rsp + 8]       # CS from interrupt frame
    test al, 3
    jnz isr80_from_user

isr80_from_kernel:
    mov r8, [rsp]            # RIP
    mov r9, [rsp + 8]        # CS
    mov r10, [rsp + 16]      # RFLAGS
    xor r11, r11             # SS = 0
    xor rax, rax             # RSP = 0
    add rsp, 24
    jmp isr80_frame_ready

isr80_from_user:
    swapgs
    mov r8, [rsp]            # RIP
    mov r9, [rsp + 8]        # CS
    mov r10, [rsp + 16]      # RFLAGS
    mov rax, [rsp + 24]      # RSP (user)
    mov r11, [rsp + 32]      # SS (user)
    mov gs:[0x0], rax
    add rsp, 40

isr80_frame_ready:
    # Build uniform frame on stack
    push r11                 # SS
    push rax                 # RSP
    push r10                 # RFLAGS
    push r9                  # CS
    push r8                  # RIP

    # Save ALL registers FIRST (including original rcx = arg2)
    # Order: rax, rbx, rcx, rdx, rsi, rdi, rbp, r8, r9, r10, r11, r12, r13, r14, r15
    push rax                 # [rsp+112] rax (syscall number)
    push rbx                 # [rsp+104] rbx (arg1)
    push rcx                 # [rsp+96]  rcx (arg2)
    push rdx                 # [rsp+88]  rdx (arg3)
    push rsi                 # [rsp+80]
    push rdi                 # [rsp+72]
    push rbp                 # [rsp+64]
    push r8                  # [rsp+56]
    push r9                  # [rsp+48]
    push r10                 # [rsp+40]  r10 (arg4)
    push r11                 # [rsp+32]
    push r12                 # [rsp+24]
    push r13                 # [rsp+16]
    push r14                 # [rsp+8]
    push r15                 # [rsp+0]

    # Calculate is_user from saved CS on stack
    # CS is at [rsp + 15*8 + 16] = [rsp + 136]
    mov rax, [rsp + 136]     # CS from frame
    xor ecx, ecx
    test al, 3
    setnz cl
    push rcx                 # is_user (pushed AFTER all registers)

    # Stack layout now:
    #   [rsp+0]   = is_user
    #   [rsp+8]   = r15  [rsp+16]  = r14  [rsp+24]  = r13  [rsp+32]  = r12
    #   [rsp+40]  = r11  [rsp+48]  = r10  [rsp+56]  = r9   [rsp+64]  = r8
    #   [rsp+72]  = rbp  [rsp+80]  = rdi  [rsp+88]  = rsi  [rsp+96]  = rdx
    #   [rsp+104] = rcx  [rsp+112] = rbx  [rsp+120] = rax

    # Translate int 0x80 calling convention to syscall_handler convention
    mov rdi, [rsp + 120]     # original rax = syscall number -> rdi
    mov rsi, [rsp + 112]     # original rbx = arg1 -> rsi
    mov rdx, [rsp + 104]     # original rcx = arg2 -> rdx
    mov rcx, [rsp + 96]      # original rdx = arg3 -> rcx
    mov r8,  [rsp + 48]      # original r10 = arg4 -> r8
    xor r9, r9               # arg5 = 0
    push 0                   # arg6 = 0 (on stack)

    call syscall_handler

    add rsp, 8               # remove arg6
    # Save return value by overwriting saved rax on stack
    mov [rsp + 120], rax

    # Pop is_user flag
    pop rcx                  # is_user

    # Restore registers
    pop r15
    pop r14
    pop r13
    pop r12
    pop r11
    pop r10
    pop r9
    pop r8
    pop rbp
    pop rdi
    pop rsi
    pop rdx
    pop rcx                  # restore original rcx (arg2)
    pop rbx
    pop rax                  # now has the return value

    # Pop frame
    pop r8                   # RIP
    pop r9                   # CS
    pop r10                  # RFLAGS
    pop rax                  # RSP (user)
    pop r11                  # SS (user)

    test rcx, rcx
    jnz isr80_ret_user

isr80_ret_kernel:
    push r10                 # RFLAGS
    push r9                  # CS
    push r8                  # RIP
    iretq

isr80_ret_user:
    swapgs
    push r11                 # SS
    push rax                 # RSP
    push r10                 # RFLAGS
    push r9                  # CS
    push r8                  # RIP
    iretq
