'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// referenceData.js — the XC compiler reference catalogue (data only, no
// vscode). Verified against the MPLAB XC8/XC16/XC32/XC-DSC user guides.
// ─────────────────────────────────────────────────────────────────────────────

const MODULES = [
    {
        id: 'xc', title: '<xc.h> — device header',
        summary: 'The top-level header the XC compilers recommend: it selects the device-specific headers and SFR definitions.',
        entries: [
            { name: '#include <xc.h>', desc: 'Includes the device headers for the selected -mcpu/-mprocessor device. Preferred over including <pic.h>/<p30fxxxx.h> directly.', signature: '#include <xc.h>' },
            { name: '#pragma config', desc: 'Set a configuration bit. XC8 also offers the older __CONFIG() macro.', signature: '#pragma config <field> = <value>' },
            { name: '_XTAL_FREQ', desc: 'XC8 only: the oscillator frequency that __delay_ms()/__delay_us() use.', signature: '#define _XTAL_FREQ 8000000UL' },
            { name: 'F_CPU / FCY', desc: 'Portable frequency macro used by delay helpers.', signature: '#define FCY 40000000UL' },
        ],
    },
    {
        id: 'delays', title: 'Delays',
        summary: 'Blocking delay helpers. On XC8 the macro needs _XTAL_FREQ; the 16/32-bit compilers provide __delay_ms/__delay_us through <libpic30.h> / <xc.h>.',
        entries: [
            { name: '__delay_ms(x)', desc: 'Busy-wait x milliseconds.', signature: 'void __delay_ms(double ms)' },
            { name: '__delay_us(x)', desc: 'Busy-wait x microseconds.', signature: 'void __delay_us(double us)' },
            { name: '__delay32(cycles)', desc: 'XC16/XC-DSC: delay a number of instruction cycles (libpic30.h).', signature: '__delay32(unsigned long cycles)' },
        ],
    },
    {
        id: 'interrupts', title: 'Interrupts',
        summary: 'ISR declarations differ by family: XC8 classic uses interrupt/ISR(), the 16/32-bit compilers use __attribute__((interrupt)).',
        entries: [
            { name: 'void __interrupt() isr(void)', desc: 'XC8 (PIC18 / enhanced mid-range): a high-priority interrupt service routine.', signature: 'void __interrupt() myISR(void) { ... }' },
            { name: 'void __interrupt(low_priority) isr(void)', desc: 'XC8: a low-priority ISR.', signature: 'void __interrupt(low_priority) myISR(void)' },
            { name: '__attribute__((interrupt))', desc: 'XC16/XC32/XC-DSC: declare a function as an ISR.', signature: 'void __attribute__((interrupt, no_auto_psv)) _T1Interrupt(void)' },
            { name: '_ISR / ISR()', desc: 'Legacy interrupt macros.', signature: 'void _ISR _T1Interrupt(void)' },
        ],
    },
    {
        id: 'sfr', title: 'SFR access',
        summary: 'Special Function Registers are declared as bit-field structs; write a whole register or a single bit.',
        entries: [
            { name: 'TRISxbits.TRISxn', desc: 'Data-direction bit (1 = input, 0 = output).', signature: 'TRISBbits.TRISB0 = 0;' },
            { name: 'LATxbits / PORTxbits', desc: 'Latch / port read-write bits.', signature: 'LATBbits.LATB0 = 1;' },
            { name: 'ANSELx / ADCONx', desc: 'Analog-select registers — a pin used as digital I/O usually must be set to digital first.', signature: 'ANSELBbits.ANSB0 = 0;' },
            { name: 'OSCCON / OSCTUNE', desc: 'Oscillator control registers.', signature: 'OSCCONbits.IRCF = 0b111;' },
        ],
    },
    {
        id: 'memory', title: 'Memory & attributes',
        summary: 'Address-space qualifiers and attributes (16/32-bit families).',
        entries: [
            { name: '__attribute__((space(...)))', desc: 'Place a variable in a named space (prog, data, eedata, dma, xmemory…).', signature: 'int __attribute__((space(prog))) tbl[] = {...};' },
            { name: '__prog__ / __psv__', desc: 'Program-space / PSV-window access qualifiers (XC16).', signature: 'const __prog__ char msg[] = "hi";' },
            { name: '__eds__', desc: 'Extended Data Space pointer (XC16/XC-DSC).', signature: '__eds__ unsigned int *p;' },
            { name: 'far / near', desc: 'XC32: place an object in the far / near region.', signature: 'far char buffer[1024];' },
            { name: 'packed / aligned', desc: 'Struct packing and alignment attributes.', signature: 'struct __attribute__((packed)) pkt { ... };' },
        ],
    },
    {
        id: 'driver', title: 'Driver options',
        summary: 'The most useful command-line options across the four drivers.',
        entries: [
            { name: '-mcpu=<device>', desc: 'XC8/XC16/XC-DSC: select the target device.', signature: 'xc8-cc -mcpu=18F4550 …' },
            { name: '-mprocessor=<device>', desc: 'XC32: select the target device.', signature: 'xc32-gcc -mprocessor=32MZ2048EFM144 …' },
            { name: '-O0 / -O1 / -O2 / -O3 / -Os', desc: 'Optimization level. -Os favors size.', signature: '-O2' },
            { name: '-c', desc: 'Compile to an object file without linking (the multi-step build).', signature: '-c src/main.c -o build/obj/main.o' },
            { name: '-o <file>', desc: 'Name the output file (ELF).', signature: '-o build/firmware.elf' },
            { name: '-I<dir>', desc: 'Add an include search directory.', signature: '-Iinclude' },
            { name: '-D<macro>[=value]', desc: 'Define a preprocessor macro.', signature: '-DF_CPU=8000000UL' },
            { name: '-T <script>', desc: 'XC16/XC-DSC: use a device linker script (p<device>.gld).', signature: '-T p33EP512MU810.gld' },
            { name: '-Wl,-Map=<file>', desc: 'Ask the linker to write a map file.', signature: '-Wl,-Map=build/firmware.map' },
            { name: '-mdfp=<path>', desc: 'Use the device support from a Device Family Pack.', signature: '-mdfp="…/DFP/xc16"' },
            { name: '-g', desc: 'Emit debug information (DWARF).', signature: '-g' },
            { name: '-Wall', desc: 'Enable common warnings.', signature: '-Wall' },
        ],
    },
    {
        id: 'binutils', title: 'Utilities',
        summary: 'The command-line utilities each toolchain ships.',
        entries: [
            { name: 'bin2hex', desc: 'Convert the linked ELF to an Intel HEX file (xc16-bin2hex / xc32-bin2hex / xc-dsc-bin2hex).', signature: 'xc16-bin2hex firmware.elf' },
            { name: 'objdump', desc: 'Disassemble and inspect the ELF (-d -S, -h).', signature: 'xc32-objdump -d -S firmware.elf' },
            { name: 'nm', desc: 'List symbols with sizes (--size-sort).', signature: 'xc32-nm --size-sort -S firmware.elf' },
            { name: 'ar', desc: 'Build a .a static library from objects.', signature: 'xc16-ar rcs libfoo.a foo.o' },
            { name: 'hexmate', desc: 'XC8 (PIC): merge/patch Intel HEX files, checksums, fill.', signature: 'hexmate app.hex -Omerged.hex' },
            { name: 'pic-objcopy', desc: 'XC8 (PIC): object/hex conversion.', signature: 'pic-objcopy -O ihex a.elf a.hex' },
        ],
    },
];

module.exports = { MODULES };
