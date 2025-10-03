// src/app/auth/page.tsx
'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '../../lib/supabase';

export default function AuthPage() {
  const router = useRouter();

  // ─── THEME TOGGLE SETUP ─────────────────────────────────────────────────────
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  useEffect(() => {
    const saved = localStorage.getItem('theme') as 'light' | 'dark' | null;
    const defaultTheme = saved || 'light';
    setTheme(defaultTheme);
    document.documentElement.classList.toggle('dark', defaultTheme === 'dark');
  }, []);
  const toggleTheme = () => {
    const next = theme === 'light' ? 'dark' : 'light';
    setTheme(next);
    document.documentElement.classList.toggle('dark', next === 'dark');
    localStorage.setItem('theme', next);
  };

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [loading, setLoading] = useState(false);

  const handleAuth = async () => {
    setLoading(true);
    try {
      let result;
      if (mode === 'login') {
        result = await supabase.auth.signInWithPassword({ email, password });
      } else {
        result = await supabase.auth.signUp({ email, password });
      }

      if (result.error) {
        alert(result.error.message);
      } else {
        router.push('/generate');
      }
    } catch {
      alert('Unexpected error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative flex items-center justify-center h-screen p-4 bg-white dark:bg-gray-900 text-black dark:text-white">
      <button
        onClick={toggleTheme}
        className="absolute top-4 right-4 text-sm border border-gray-400 dark:border-gray-600 px-3 py-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700"
      >
        Switch to {theme === 'light' ? 'Dark' : 'Light'} Mode
      </button>

      <div className="w-full max-w-xs bg-white dark:bg-gray-800 p-6 rounded-md shadow-md space-y-4">
        <h1 className="text-xl font-bold text-center">
          {mode === 'login' ? 'Login to your account' : 'Create a new account'}
        </h1>

        <input
          className="w-full p-2 mb-2 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-black dark:text-white rounded"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />

        <input
          className="w-full p-2 mb-4 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-black dark:text-white rounded"
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />

        <button
          onClick={handleAuth}
          disabled={loading}
          className="w-full bg-blue-500 hover:bg-blue-600 text-white px-4 py-2 rounded disabled:opacity-50"
        >
          {loading
            ? 'Please wait...'
            : mode === 'login'
            ? 'Log In'
            : 'Sign Up'}
        </button>

        <p className="text-center text-sm">
          {mode === 'login' ? 'Need an account?' : 'Already have an account?'}{' '}
          <button
            onClick={() => setMode(mode === 'login' ? 'signup' : 'login')}
            className="text-blue-500 underline"
          >
            {mode === 'login' ? 'Sign up' : 'Log in'}
          </button>
        </p>
      </div>
    </div>
  );
}

