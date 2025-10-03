// src/components/WordPressIntegration.tsx
'use client';

import React, { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';

type Account = { id: string; site_url: string; username: string };

interface Props {
  title: string;
  content: string;
}

export default function WordPressIntegration({ title, content }: Props) {
  const [accounts, setAccounts]     = useState<Account[]>([]);
  const [userId, setUserId]         = useState<string>('');
  const [selectedId, setSelectedId] = useState<string>('');
  const [promoHtml, setPromoHtml]   = useState<string>('');
  const [siteUrl, setSiteUrl]       = useState<string>('');
  const [username, setUsername]     = useState<string>('');
  const [password, setPassword]     = useState<string>('');
  const [msg, setMsg]               = useState<string>('');
  const [msgType, setMsgType]       = useState<'info' | 'error' | 'success'>('info');
  const [publishing, setPublishing] = useState<boolean>(false);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (data.user) setUserId(data.user.id);
    });
  }, []);

  // 1) Load saved WP accounts
  const loadAccounts = async () => {
    if (!userId) return;
    setMsg('Loading accounts…');
    setMsgType('info');
    const res  = await fetch(`/api/wordpress/accounts?userId=${userId}`);
    const json = await res.json();
    if (res.ok && Array.isArray(json.accounts)) {
      setAccounts(json.accounts);
      setMsg('');
      setMsgType('info');
    } else {
      console.error('Could not load accounts:', json.error);
      setMsg('Failed to load accounts');
      setMsgType('error');
    }
  };

  useEffect(() => {
    loadAccounts();
  }, [userId]);

  // Load promo HTML when an account is selected
  useEffect(() => {
    const loadPromo = async () => {
      if (!userId || !selectedId) {
        setPromoHtml('');
        return;
      }
      const res = await fetch(
        `/api/wordpress/promo?userId=${userId}&accountId=${selectedId}`
      );
      const json = await res.json();
      if (res.ok) setPromoHtml(json.footer_html || '');
    };
    loadPromo();
  }, [selectedId, userId]);

  // 2) Add a new WP account
  const addAccount = async () => {
    setMsg('');
    setMsgType('info');
    if (!siteUrl || !username || !password) {
      setMsg('Fill site URL, username & password');
      setMsgType('error');
      return;
    }

    const res  = await fetch('/api/wordpress/add-account', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, siteUrl, username, password }),
    });
    const json = await res.json();

    if (!res.ok) {
      console.error('Add-account error:', json.error);
      setMsg('Add-account failed: ' + (json.error || res.status));
      setMsgType('error');
    } else {
      setMsg('Account added!');
      setMsgType('success');
      setSiteUrl('');
      setUsername('');
      setPassword('');
      await loadAccounts();
    }
  };

  // 3) Delete an existing WP account
  const deleteAccount = async (id: string) => {
    setMsg('');
    setMsgType('info');
    if (!confirm('Are you sure you want to delete this account?')) return;
    const res  = await fetch('/api/wordpress/delete-account', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, accountId: id }),
    });
    const json = await res.json();

    if (!res.ok) {
      console.error('Delete-account error:', json.error);
      setMsg('Delete failed: ' + (json.error || res.status));
      setMsgType('error');
    } else {
      setMsg('Account deleted');
      setMsgType('success');
      setAccounts((prev) => prev.filter((a) => a.id !== id));
      if (selectedId === id) setSelectedId('');
    }
  };

  // Save promo HTML for the selected account
  const savePromo = async () => {
    if (!selectedId) return;
    const res = await fetch('/api/wordpress/promo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, accountId: selectedId, footer_html: promoHtml }),
    });
    const json = await res.json();
    if (!res.ok) {
      console.error('Promo save error:', json.error);
      setMsg('Failed to save promo');
      setMsgType('error');
    } else {
      setMsg('Promo saved');
      setMsgType('success');
    }
  };

  // Convert a data URL to a Blob
  const dataUrlToBlob = (dataUrl: string): Blob => {
    const [header, data] = dataUrl.split(',');
    const mime = header.match(/:(.*?);/)?.[1] || 'image/jpeg';
    const binary = atob(data);
    const array = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) array[i] = binary.charCodeAt(i);
    return new Blob([array], { type: mime });
  };

  // Resize/crop an image Blob using a canvas
  const getCroppedImg = async (blob: Blob): Promise<Blob> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Failed to read image'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('Failed to load image'));
        img.onload = () => {
          const maxWidth = 1200;
          let { width, height } = img;
          if (width > maxWidth) {
            height = (height * maxWidth) / width;
            width = maxWidth;
          }
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            reject(new Error('Canvas context not available'));
            return;
          }
          ctx.drawImage(img, 0, 0, width, height);
          canvas.toBlob(
            (b) => {
              if (b) resolve(b);
              else reject(new Error('Canvas is empty'));
            },
            blob.type || 'image/jpeg',
            0.9
          );
        };
        img.src = reader.result as string;
      };
      reader.readAsDataURL(blob);
    });
  };

  // Upload any data/external images in the content to WordPress media library
  const replaceImageSources = async (
    html: string,
    account: Account
  ): Promise<string> => {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const imgs = Array.from(doc.querySelectorAll('img'));
    const cache: Record<string, string> = {};

    for (const img of imgs) {
      const src = img.getAttribute('src') || '';
      const isData = src.startsWith('data:');
      const isExternal = /^https?:\/\//i.test(src);
      if (!isData && !isExternal) continue;

      if (cache[src]) {
        img.setAttribute('src', cache[src]);
        continue;
      }

      try {
        let blob: Blob;
        if (isData) {
          blob = dataUrlToBlob(src);
        } else {
          const fetched = await fetch(src);
          if (!fetched.ok) throw new Error('Failed to fetch image');
          const original = await fetched.blob();
          blob = await getCroppedImg(original);
        }

        const formData = new FormData();
        formData.append('file', blob, `image-${Date.now()}.jpg`);

        const mediaUrl =
          account.site_url.replace(/\/$/, '') + '/wp-json/wp/v2/media';
        const uploadRes = await fetch(
          `/api/wordpress/proxy?userId=${userId}&accountId=${selectedId}&url=${encodeURIComponent(mediaUrl)}`,
          {
            method: 'POST',
            body: formData,
          }
        );
        const uploadJson = await uploadRes.json();
        if (!uploadRes.ok) {
          throw new Error(uploadJson.error || uploadRes.statusText);
        }
        const newUrl = uploadJson.source_url || uploadJson.guid?.rendered;
        if (!newUrl) throw new Error('No media URL returned');

        img.setAttribute('src', newUrl);
        cache[src] = newUrl;
      } catch (err: any) {
        throw new Error(err?.message || 'Image upload failed');
      }
    }

    return doc.body.innerHTML;
  };

  // 4) Publish the article
  const publish = async () => {
    setMsg('');
    setMsgType('info');
    setPublishing(true);
    if (!selectedId) {
      setMsg('Please select a site');
      setMsgType('error');
      setPublishing(false);
      return;
    }
    if (!title) {
      setMsg('Missing title');
      setMsgType('error');
      setPublishing(false);
      return;
    }
    if (!content) {
      setMsg('Nothing to publish (content empty)');
      setMsgType('error');
      setPublishing(false);
      return;
    }
  
    console.log('WP proxy publish payload:', { accountId: selectedId, title, content });

    try {
      const account = accounts.find((a) => a.id === selectedId);
      if (!account) {
        throw new Error('Selected account not found');
      }

      // Replace image sources with uploaded media URLs
      let updatedContent = content;
      try {
        updatedContent = await replaceImageSources(content, account);
      } catch (imgErr: any) {
        throw new Error(imgErr?.message || 'Image upload failed');
      }

      const postsUrl = account.site_url.replace(/\/$/, '') + '/wp-json/wp/v2/posts';

      const res = await fetch(
        `/api/wordpress/proxy?userId=${userId}&accountId=${selectedId}&url=${encodeURIComponent(postsUrl)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, content: updatedContent }),
        }
      );

      const json = await res.json();

      if (!res.ok) {
        console.error('Proxy publish error:', json.error);
        setMsg('Publish failed: ' + (json.error || res.status));
        setMsgType('error');
      } else {
        setMsg(`Draft saved! Post ID: ${json.id || json.post?.id}`);
        setMsgType('success');
      }
    } catch (err: any) {
      console.error('Publish request failed:', err);
      setMsg('Publish failed: ' + (err?.message || 'Unknown error'));
      setMsgType('error');
    } finally {
      setPublishing(false);
    }
  };
  

  return (
    <div className="border border-gray-300 dark:border-gray-600 p-4 mt-4 rounded space-y-4 bg-white dark:bg-gray-800 text-black dark:text-white">
      <h2 className="text-xl font-bold dark:text-white">Publish to WordPress</h2>
      {msg && (
        <p
          className={`font-semibold ${
            msgType === 'error'
              ? 'text-red-500'
              : msgType === 'success'
              ? 'text-green-600 dark:text-green-400'
              : 'text-gray-600 dark:text-gray-300'
          }`}
        >
          {msg}
        </p>
      )}

      {/* Select & DELETE list */}
      {accounts.map((a) => (
        <div key={a.id} className="flex items-center">
          <label className="flex-1 text-black dark:text-white">
            <input
              type="radio"
              name="wpAccount"
              value={a.id}
              checked={selectedId === a.id}
              onChange={() => setSelectedId(a.id)}
              className="mr-2"
            />
            {a.site_url} ({a.username})
          </label>
          <button
            onClick={() => deleteAccount(a.id)}
            className="ml-2 text-red-500 hover:text-red-700"
            title="Delete this account"
          >
            🗑️
          </button>
        </div>
      ))}

      {selectedId && (
        <div className="mt-2 space-y-2">
          <textarea
            value={promoHtml}
            onChange={(e) => setPromoHtml(e.target.value)}
            placeholder="Promo footer HTML"
            className="w-full h-24 border border-gray-300 dark:border-gray-600 p-2 rounded bg-white dark:bg-gray-700 text-black dark:text-white"
          />
          <button
            onClick={savePromo}
            className="w-full bg-blue-600 hover:bg-blue-700 text-white py-1 rounded"
          >
            Save Footer
          </button>
        </div>
      )}

      <button
        onClick={publish}
        disabled={!selectedId || publishing}
        className="w-full bg-green-600 text-white py-2 rounded hover:bg-green-700 disabled:opacity-50 flex items-center justify-center"
      >
        {publishing && (
          <svg
            className="animate-spin h-5 w-5 mr-2 text-white"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            ></circle>
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
            ></path>
          </svg>
        )}
        {publishing ? 'Drafting…' : 'Draft Article'}
      </button>

      <hr className="border-gray-200 dark:border-gray-700" />

      <h2 className="text-xl font-bold dark:text-white">Add a New WordPress Account</h2>
      <input
        type="text"
        placeholder="Site URL (e.g. https://example.com)"
        value={siteUrl}
        onChange={(e) => setSiteUrl(e.target.value)}
        className="w-full border border-gray-300 dark:border-gray-600 p-2 mb-2 bg-white dark:bg-gray-700 text-black dark:text-white rounded"
      />
      <input
        type="text"
        placeholder="Username"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        className="w-full border border-gray-300 dark:border-gray-600 p-2 mb-2 bg-white dark:bg-gray-700 text-black dark:text-white rounded"
      />
      <input
        type="password"
        placeholder="Application Password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        className="w-full border border-gray-300 dark:border-gray-600 p-2 mb-2 bg-white dark:bg-gray-700 text-black dark:text-white rounded"
      />
      <button
        onClick={addAccount}
        className="w-full bg-blue-600 hover:bg-blue-700 text-white py-2 rounded"
      >
        Add Account
      </button>

    </div>
  );
}
