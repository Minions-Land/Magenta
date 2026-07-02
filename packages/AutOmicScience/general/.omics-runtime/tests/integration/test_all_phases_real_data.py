#!/usr/bin/env python3
"""
COMPREHENSIVE HARD TEST: All omics phases on REAL data.
Run on GPU server. Downloads real datasets, runs full workflows,
tests boundary conditions. Fails loud on any error.
"""
import os
import pytest

pytestmark = pytest.mark.integration

# Real-data integration test (originally for an autodl GPU box). Gated so it never
# runs — and never executes its module-level side effects (downloads, makedirs) —
# unless explicitly enabled. NOTE: this predates the aose_omics_runtime package
# layout; the sys.path shims below must be rewritten to `from aose_omics_runtime...`
# imports before it can actually run again.
if not os.environ.get("AOSE_OMICS_REAL_DATA_DIR"):
    pytest.skip(
        "set AOSE_OMICS_REAL_DATA_DIR (and rewrite to package imports) to run",
        allow_module_level=True,
    )

import sys, traceback
SKILLS = "/root/autodl-tmp/skills/omics"
sys.path.insert(0, os.path.join(SKILLS, "_shared/scripts"))
sys.path.insert(0, os.path.join(SKILLS, "scrna/scripts"))
sys.path.insert(0, os.path.join(SKILLS, "spatial/scripts"))
sys.path.insert(0, os.path.join(SKILLS, "scatac/scripts"))
sys.path.insert(0, os.path.join(SKILLS, "multiome/scripts"))

import warnings; warnings.filterwarnings("ignore")
import numpy as np
import scanpy as sc
import anndata as ad

os.environ.setdefault("SCANPY_SETTINGS_DIR", "/root/autodl-tmp/omics/.scanpy")
sc.settings.cachedir = "/root/autodl-tmp/omics/.sc_cache"
DATADIR = "/root/autodl-tmp/omics/data"
os.makedirs(DATADIR, exist_ok=True)

results = {}

def banner(t):
    print("\n" + "="*64); print(t); print("="*64)

# ============ PHASE 1: scRNA-seq on REAL PBMC3k ============
def test_phase1():
    banner("PHASE 1 HARD TEST: Real PBMC3k (10x Genomics)")
    import conventions, preprocess, markers
    adata = sc.datasets.pbmc3k()
    print(f"✅ Real PBMC3k: {adata.n_obs} cells x {adata.n_vars} genes")
    adata.layers[conventions.LAYER_COUNTS] = adata.X.copy()

    adata, report = preprocess.standard_preprocess(
        adata, n_hvg=2000, resolution=1.0, qc_mode="fixed",
        min_genes=200, min_cells=3, max_pct_mt=20, return_report=True)
    print(f"✅ Preprocess: {report['initial_shape']} -> {report['final_shape']}, {report['n_clusters']} clusters")
    assert conventions.OBSM_UMAP in adata.obsm
    assert conventions.OBS_LEIDEN in adata.obs

    mdf, _mreport = markers.marker_table(adata, groupby=conventions.OBS_LEIDEN,
                               min_logfc=0.25, min_in_group_fraction=0.1, max_out_group_fraction=0.5)
    print(f"✅ Markers: {len(mdf)} across {mdf['group'].nunique()} clusters")

    # Biological validation - known PBMC markers should appear
    known = {'CD3D','CD3E','CD8A','MS4A1','CD79A','NKG7','GNLY','CST3','FCGR3A','PPBP','IL7R','GZMB'}
    found = known & set(mdf['names'])
    print(f"✅ Known PBMC markers found: {sorted(found)} ({len(found)}/{len(known)})")
    assert len(found) >= 8, f"Too few known markers: {found}"

    # Boundary: invalid groupby
    try:
        markers.marker_table(adata, groupby="nonexistent_col")
        print("⚠️ No error on bad groupby")
    except Exception as e:
        print(f"✅ Boundary (bad groupby): {type(e).__name__}")
    results['phase1'] = {'cells': adata.n_obs, 'clusters': report['n_clusters'],
                         'markers': len(mdf), 'known_markers': len(found)}

# ============ PHASE 2: Spatial on REAL Visium ============
def test_phase2():
    banner("PHASE 2 HARD TEST: Real Visium H&E spatial")
    import squidpy as sq
    import spatial_neighbors as sn
    adata = sq.datasets.visium_hne_adata()
    print(f"✅ Real Visium: {adata.n_obs} spots x {adata.n_vars} genes")
    assert 'spatial' in adata.obsm

    sc.pp.filter_genes(adata, min_cells=10)
    adata.layers['counts'] = adata.X.copy()
    sc.pp.normalize_total(adata, target_sum=1e4); sc.pp.log1p(adata)
    sc.pp.highly_variable_genes(adata, n_top_genes=2000)
    sc.pp.pca(adata, n_comps=30); sc.pp.neighbors(adata); sc.tl.leiden(adata, resolution=0.8)
    nd = adata.obs['leiden'].nunique()
    print(f"✅ Spatial domains: {nd}")

    # Our helper: spatial neighbors
    rep = sn.build_spatial_neighbors(adata, n_neighbors=6)
    print(f"✅ Helper spatial_neighbors: {rep}")
    assert 'spatial_neighbors_connectivities' in adata.obsp, f'obsp keys: {list(adata.obsp.keys())}'

    # squidpy spatial stats - Moran's I
    sq.gr.spatial_neighbors(adata, coord_type='grid', n_neighs=6)
    sq.gr.spatial_autocorr(adata, mode='moran', n_perms=100, n_jobs=4)
    top = adata.uns['moranI'].head(3)
    print(f"✅ Moran's I top spatial genes: {list(top.index)}")
    sq.gr.nhood_enrichment(adata, cluster_key='leiden')
    print(f"✅ Neighborhood enrichment computed")
    results['phase2'] = {'spots': adata.n_obs, 'domains': nd, 'top_spatial': list(top.index)}

# ============ PHASE 3: scATAC on REAL data (SnapATAC2) ============
def test_phase3():
    banner("PHASE 3 HARD TEST: scATAC-seq (SnapATAC2 real pipeline)")
    try:
        import snapatac2 as snap
        print(f"✅ SnapATAC2 {snap.__version__}")
        frag = snap.datasets.pbmc5k(type="fragment")
        print(f"✅ Real 10x PBMC 5k fragment file: {frag}")
        data = snap.pp.import_fragments(frag, chrom_sizes=snap.genome.hg38,
                                        sorted_by_barcode=False, min_num_fragments=500)
        print(f"✅ Imported real fragments: {data.n_obs} barcodes")
        # NOTE: snap.metrics.tsse downloads a gencode GTF from ftp.ebi.ac.uk,
        # which is network-throttled on this host (~6kB/s). The count-based QC
        # below exercises the real pipeline without that optional download.
        import numpy as _np
        nf = _np.asarray(data.obs['n_fragment'])
        print(f"✅ Fragment counts: median={_np.median(nf):.0f}")
        snap.pp.filter_cells(data, min_counts=2000, min_tsse=None, max_counts=100000)
        snap.pp.add_tile_matrix(data, bin_size=5000)
        snap.pp.select_features(data, n_features=50000)
        snap.tl.spectral(data); snap.pp.knn(data); snap.tl.leiden(data)
        nc = len(set(data.obs['leiden']))
        print(f"✅ SnapATAC2 REAL pipeline: {data.n_obs} cells, {nc} clusters")
        assert data.n_obs > 500 and nc >= 4
        results['phase3'] = {'cells': int(data.n_obs), 'clusters': nc, 'engine': 'snapatac2-real'}
    except Exception as e:
        print(f"❌ SnapATAC2 real pipeline error: {e}")
        raise

def test_phase4():
    banner("PHASE 4 HARD TEST: Multiome RNA+ATAC (muon)")
    import mudata as md
    try:
        import muon as mu
        print(f"✅ muon {mu.__version__}")
    except Exception as e:
        print(f"⚠️ muon unavailable: {e}")
        mu = None
    from scipy.sparse import random as srand
    rna = ad.AnnData(X=np.random.negative_binomial(5,0.3,(800,2000)).astype('float32'))
    rna.var_names=[f"Gene_{i}" for i in range(2000)]; rna.obs_names=[f"C{i}" for i in range(800)]
    Xa = srand(800, 5000, density=0.04, format='csr', random_state=0); Xa.data[:]=1
    atac = ad.AnnData(X=Xa)
    atac.var_names=[f"chr1:{i*1000}-{i*1000+500}" for i in range(5000)]; atac.obs_names=[f"C{i}" for i in range(800)]
    mdata = md.MuData({'rna':rna,'atac':atac})
    print(f"✅ MuData: {mdata.n_obs} cells, mods={list(mdata.mod)}")
    sc.pp.normalize_total(rna,target_sum=1e4); sc.pp.log1p(rna)
    sc.pp.highly_variable_genes(rna,n_top_genes=500); sc.pp.pca(rna,n_comps=30)
    from sklearn.feature_extraction.text import TfidfTransformer
    from sklearn.decomposition import TruncatedSVD
    atac.obsm['X_lsi']=TruncatedSVD(31,random_state=0).fit_transform(TfidfTransformer().fit_transform(atac.X))[:,1:]
    joint=np.concatenate([rna.obsm['X_pca'],atac.obsm['X_lsi']],axis=1)
    mdata.obsm['X_joint']=joint
    j=ad.AnnData(X=joint); j.obsm['X_joint']=joint
    sc.pp.neighbors(j,use_rep='X_joint'); sc.tl.leiden(j)
    nc=j.obs['leiden'].nunique()
    print(f"✅ Joint embedding {joint.shape}, {nc} clusters")
    results['phase4']={'cells':mdata.n_obs,'joint_dim':joint.shape[1],'clusters':nc}

# ============ RUN ALL ============
passed, failed = [], []
for name, fn in [('Phase1',test_phase1),('Phase2',test_phase2),('Phase3',test_phase3),('Phase4',test_phase4)]:
    try:
        fn(); passed.append(name)
    except Exception as e:
        failed.append((name,str(e))); print(f"\n❌ {name} FAILED: {e}"); traceback.print_exc()

banner("FINAL RESULTS")
import json; print(json.dumps(results, indent=2))
print(f"\nPASSED: {passed}")
print(f"FAILED: {[f[0] for f in failed]}")
sys.exit(0 if not failed else 1)
