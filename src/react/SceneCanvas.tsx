import { useEffect } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import type { PerspectiveCamera, WebGLRenderer, Scene } from 'three';

import type { OrbitControlsLike, SplatNavController } from '@/react/three/SplatNavController';

function ControllerBridge({ controller }: { controller: SplatNavController }): null {
  const scene = useThree((s) => s.scene) as Scene;
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const gl = useThree((s) => s.gl) as WebGLRenderer;
  const controls = useThree((s) => s.controls) as OrbitControlsLike | null;

  useEffect(() => {
    controller.attach({ scene, camera, gl, controls: controls ?? null });
    return () => controller.detach();
  }, [controller, scene, camera, gl]);

  useEffect(() => {
    controller.setControls(controls ?? null);
  }, [controller, controls]);

  useFrame((_, delta) => controller.update(delta));
  return null;
}

/**
 * The R3F render surface for the FAST NAV demo. The heavy lifting (splat,
 * floor/navmesh overlays, crowd) lives in {@link SplatNavController}; this
 * component only wires the three.js context and the per-frame tick.
 */
export function SceneCanvas({ controller }: { controller: SplatNavController }): JSX.Element {
  return (
    <Canvas
      camera={{ position: [6, 6, 6], fov: 45.84, near: 0.1, far: 1000 }}
      gl={{ antialias: true }}
      style={{ width: '100%', height: '100%', display: 'block', background: '#000', touchAction: 'none' }}
    >
      <color attach="background" args={['#000000']} />
      <ambientLight intensity={0.9} />
      <hemisphereLight args={[0xffffff, 0x202030, 1.0]} />
      <directionalLight position={[5, 10, 7]} intensity={0.7} />
      <OrbitControls makeDefault enableDamping dampingFactor={0.1} />
      <ControllerBridge controller={controller} />
    </Canvas>
  );
}
