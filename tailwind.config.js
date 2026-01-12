const defaultTheme = require('tailwindcss/defaultTheme');

/** @type {import('tailwindcss').Config} */
module.exports = {
    darkMode: 'class',
    content: [
        "./ui/**/*.{js,jsx,ts,tsx}",
        "./src/**/*.{js,jsx,ts,tsx}",
        "./public/**/*.html"
    ],
    theme: {
        extend: {
            fontFamily: {
                // If you license Suisse Intl, replace 'Inter' with 'Suisse Intl'
                sans: [
                    'Inter',
                    '"Inter Fallback"',
                    ...defaultTheme.fontFamily.sans,
                ],
                mono: [
                    '"DM Mono"',
                    ...defaultTheme.fontFamily.mono,
                ],
            },

            colors: {
                // Primary brand: Convergence Blue
                brand: {
                    50: '#E2E8F0',
                    100: '#CBD5E0',
                    200: '#A0AEC0',
                    300: '#718096',
                    400: '#4A5568',
                    500: '#2D3748', // Convergence Blue
                    600: '#1A202C',
                    700: '#111827',
                },

                // Surfaces – Void Black base, subtle lifts
                surface: {
                    DEFAULT: '#0A0A0B',              // Void Black (app background)
                    soft: '#0B1013',              // subtle variation for chat area
                    raised: '#111827',              // primary card background
                    highest: '#0F172A',              // trays/modals/popovers
                    highlight: 'rgba(148,163,184,0.16)', // subtle hover
                    overlay: 'rgba(0,0,0,0.75)',    // dark overlay for insets
                    code: '#020617',             // code blocks
                    modal: '#020617',             // modal panels
                },

                input: {
                    DEFAULT: '#0A0F1A',              // input bars
                    subtle: '#020617',
                },

                overlay: {
                    backdrop: '#020617',             // use /70, /80 for opacity
                },

                text: {
                    primary: '#F8F9FA',            // Platinum White
                    secondary: '#E2E8F0',            // slightly dimmed
                    muted: '#A0AEC0',            // subtle labels
                    brand: '#A0AEC0',            // brand-tinted headings if needed
                },

                border: {
                    subtle: 'rgba(148,163,184,0.28)',
                    strong: 'rgba(148,163,184,0.5)',
                    brand: '#2D3748',
                },

                chip: {
                    DEFAULT: 'rgba(15,23,42,0.85)',
                    active: 'rgba(45,55,72,0.75)',   // Convergence Blue-tinted
                    soft: 'rgba(15,23,42,0.6)',
                },

                // Brand-aligned status colors
                intent: {
                    success: '#4A9B8E',  // Neural Teal
                    warning: '#F6AD55',  // Insight Amber
                    danger: '#FC8181',  // Warning Coral
                    info: '#63B3ED',  // supplementary blue for info
                },
            },

            borderRadius: {
                '2xl': '12px',
                '3xl': '1.5rem',
                pill: '9999px',
            },

            boxShadow: {
                card: '0 12px 30px rgba(0,0,0,0.7)',
                'card-sm': '0 2px 8px rgba(0,0,0,0.35)',
                elevated: '0 20px 45px rgba(0,0,0,0.85)',
                'glow-brand': '0 0 0 2px rgba(45,55,72,0.7), 0 10px 30px rgba(45,55,72,0.5)',
                'glow-brand-soft': '0 0 18px rgba(45,55,72,0.55)',
                overlay: '0 20px 25px -5px rgba(0,0,0,0.7), 0 10px 10px -5px rgba(0,0,0,0.6)',
            },

            backgroundImage: {
                // Singularity Gradient: Void Black → Convergence Blue → Platinum White
                'singularity-gradient':
                    'linear-gradient(135deg, #0A0A0B 0%, #2D3748 50%, #F8F9FA 100%)',

                // App background – Void Black → Convergence Blue → Void Black (horizontal gradient)
                'app-gradient':
                    'linear-gradient(90deg, #0A0A0B 0%, #2D3748 50%, #0A0A0B 100%)',

                // Processing Gradient: Neural Teal → Insight Amber
                'processing-gradient':
                    'linear-gradient(90deg, #4A9B8E 0%, #F6AD55 100%)',

                // Header gradient – mostly black with a soft Convergence glow from top
                'header-gradient':
                    'radial-gradient(circle at top, rgba(45,55,72,0.35), transparent 55%), linear-gradient(180deg, #0A0A0B, #0A0A0B)',
            },

            keyframes: {
                'slide-up': {
                    '0%': { opacity: '0', transform: 'translateY(12px)' },
                    '100%': { opacity: '1', transform: 'translateY(0)' },
                },
            },
            animation: {
                'slide-up': 'slide-up 0.3s ease-out',
            },
        },
    },
    plugins: [],
};
