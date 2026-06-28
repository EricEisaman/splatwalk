# Troubleshooting: SOG Export "Unreachable" Error

## Your Issue
```
Loading file: gothic_church.ply (269628213 bytes)
Processing file...
Input splat visualized. Ready for setup.
Parsed 4399819 splats
Exporting streamed LOD SOG...
SOG export failed: unreachable
```

## What's Happening

Your 296 MB PLY file with 4.4 million splats is hitting a **memory or performance limit** during the SOG (Spatially-Ordered Gaussian) export process.

### Why It Fails

The error occurs during the **Spherical Harmonics (SH) k-means clustering** phase, which requires:
- **~791 MB** just for the SH coefficient vectors (4.4M splats × 45 values each)
- **Large temporary buffers** for k-means convergence (4096 clusters by default)
- **WebP encoding** for compression into lossless planes

The WASM module is likely **running out of memory** or hitting an internal limit during processing.

---

## ✅ Immediate Workarounds

### Option 1: Use Single SOG Export (Recommended)
Instead of **Streamed LOD** (which chunks the data), use **Single SOG**:

1. Go to **SOG Export** section
2. Select radio button: **"Single SOG"** (not "Streamed LOD")
3. Click **"Export SOG ZIP"**

**Why this works:**
- Simpler export path with fewer intermediate allocations
- Single `meta.json` + planes instead of multiple LOD chunks
- More reliable for very large files

### Option 2: Reduce SH Quality Settings
Reduce memory pressure by lowering SH settings:

1. In **SOG Export** → **Settings**:
   - **SH Palette Size**: Change from `4096` → `2048` or `1024`
   - **SH Iterations**: Change from `10` → `5` or `3`

**What this does:**
- Fewer clusters = less memory for k-means
- Faster convergence = less processing time

### Option 3: Disable Spherical Harmonics Entirely
If you don't need detailed color variations:

1. In **SOG Export** → **Settings**:
   - **SH Degree**: Change from `3` → `0`

**What this does:**
- Skips expensive SH encoding completely
- Exports only base color + opacity
- Uses ~90% less memory during export
- Still produces valid SOG LOD bundles

### Option 4: Split Your File
Process the scene in sections:

1. **In Babylon Viewer**:
   - Use the "Region" or "Collider" controls to isolate parts of the scene
   - Export each region separately
   - Combine the exports if needed

---

## 📊 Detailed Settings Guide

### Export Mode Comparison

| Setting | Single SOG | Streamed LOD |
|---------|-----------|-------------|
| **Memory** | Lower | Higher (processes multiple chunks) |
| **File Size** | Larger | Multiple smaller files |
| **Best For** | Desktop viewing | Progressive streaming/large scenes |
| **Reliability** | Higher | Needs more memory |

### SH Quality Settings

| SH Degree | Memory Impact | Quality | Use Case |
|-----------|---------------|---------|----------|
| 0 | ✅ Very Low | Base color only | Quick export, memory-constrained |
| 1 | Low | Basic detail | Mobile viewing |
| 2 | Medium | Good detail | Most uses |
| 3 | ❌ Highest | Best detail | High-quality desktop viewing |

| Palette Size | Memory | Quality |
|-------------|--------|---------|
| 1024 | ✅ Low | Adequate |
| 2048 | Medium | Good |
| 4096 | ❌ High | Excellent |
| 8192+ | Very High | Diminishing returns |

| SH Iterations | Time | Convergence |
|---------------|------|-------------|
| 1-3 | ✅ Fast | Fair |
| 5 | Medium | Good |
| 10 | ⏱ Slow | Excellent |

---

## 🔧 Recommended Settings for Large Files

### For 4.4M Splats
```
SH Degree:        2 or 3 (quality preference)
SH Palette Size:  1024 or 2048  
SH Iterations:    5 or 3
Chunk Count:      256000 (default, OK)
Chunk Extent:     16 (default, OK)
LOD Levels:       1 (default, OK)
```

### For Maximum Compatibility
```
SH Degree:        0  (base color only)
SH Palette Size:  1024
SH Iterations:    1
Chunk Count:      256000
Chunk Extent:     16
LOD Levels:       1
```

---

## 🧪 Step-by-Step Testing

### Test 1: Verify Setup
✅ File loads successfully  
✅ Can visualize the splat  
✅ "Parsed 4,399,819 splats" appears

### Test 2: Try Single SOG with SH Degree 0
1. Set **SH Degree → 0**
2. Set **Export Mode → Single SOG**
3. Click **Export SOG ZIP**

Expected: Export completes in 5-10 seconds

### Test 3: Try Streamed LOD with Lower Settings
1. Set **SH Degree → 1**
2. Set **SH Palette Size → 1024**
3. Set **Export Mode → Streamed LOD**
4. Click **Export SOG ZIP**

Expected: Export completes without "unreachable" error

### Test 4: Gradually Increase Quality
If Test 3 succeeds:
- Increase **SH Palette Size** to 2048
- Test again
- Increase **SH Degree** to 2, then 3
- Find the sweet spot

---

## 📱 Browser Considerations

### Memory Available
- **Chrome/Chromium**: ~2 GB WASM memory (usually sufficient)
- **Firefox**: ~2 GB WASM memory (similar to Chrome)
- **Safari**: ~1-2 GB (more conservative, may fail sooner)
- **Mobile**: Often 512 MB - 1 GB (upgrade to desktop for large files)

### If You Keep Getting "Unreachable"
1. Close other browser tabs (free up memory)
2. Restart the browser
3. Try with **SH Degree → 0** first
4. Upgrade to a desktop browser if on mobile
5. Reduce **Chunk Count** if using Streamed LOD (try 128,000 instead of 256,000)

---

## 📈 Next Steps

### Short Term
1. Try **Single SOG export** with these settings:
   - SH Degree: **2**
   - SH Palette Size: **2048**
   - SH Iterations: **5**

2. If that works, gradually increase SH Palette Size and Degree

### Medium Term (If Issues Persist)
- File a bug report with:
  - File size (296 MB)
  - Splat count (4.4M)
  - Browser & version
  - Settings used
  - Steps to reproduce

### Long Term (Planned Improvements)
- [ ] Memory usage estimation before export
- [ ] Automatic setting recommendations based on file size
- [ ] Progressive/chunked export for very large files
- [ ] Better error messages indicating memory constraints
- [ ] Streaming k-means to reduce peak memory usage

---

## 📞 Support

### If Single SOG with SH Degree 0 still fails:
- Check browser console for detailed error (F12 → Console tab)
- Note the exact error message
- Try reducing **Chunk Count** to 128,000

### If you need the Streamed LOD export specifically:
- Start with smallest possible SH settings (Degree 0, Iterations 1)
- Gradually increase until you find the limit
- This tells us your browser's exact memory capacity

---

## 🎯 Expected Export Performance

| Size | Mode | SH Degree | Time |
|------|------|-----------|------|
| 4.4M | Single | 0 | 2-5 sec |
| 4.4M | Single | 2 | 8-15 sec |
| 4.4M | Single | 3 | 15-30 sec |
| 4.4M | Streamed | 0 | 10-20 sec |
| 4.4M | Streamed | 2 | 30-60 sec |
| 4.4M | Streamed | 3 | 60+ sec |

If export takes >60 seconds or hits "unreachable", try reducing settings.
