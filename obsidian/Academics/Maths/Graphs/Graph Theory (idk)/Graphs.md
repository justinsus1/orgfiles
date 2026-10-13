#Maths/Geometry/GraphTheory
[[Graphs]] represent relationships between [[Objects]], such as the x and y coordinates.

![[Drawing 2026-07-19 01.06.38.excalidraw]]
This a graph depicting multiple features of [[Edge]]s and [[Vertices]]

- The degree of a vertex is the number of [[Edge]] ends attached to it (how many ways you can leave the vertex)
- A graph is connected if you can travel to all the [[Vertices]] in the graph

#### Handshaking lemma
Every [[Edge]] has 2 ends. However the degrees of a vertex counts the number of [[Edge]] ends attached.
$\therefore$ The sum of all degrees = 2 $\times$ the number of edges
Otherwise the graph is not possible

## Isomorphic graphs
When 2 or more graphs have the same structure (relations), they are known as isomorphic graphs

![[isomorphic.excalidraw]]

These two are isomorphic because you can [[transform]] the square into the second [[quadrilateral]] without changing the innate relationships between the different [[Vertices]]


## Cycle graphs

To draw a cycle graph
- Place n [[Vertices]] around in a circle
- Pick a whole number s (the skipping number)
- Join each vertex by a single [[Edge]] to the vertex s places to its left

![[cycleGraph.excalidraw|1000]]

## Complete graphs
Complete [[Graphs]] is one in which every vertex is connected to eachother.
We use the symbol $K~n$ to represent a complete graph with n [[Vertices]]

![[completeGraphs.excalidraw|1000]]

## Planar graphs
Planar graphs are graphs that can be drawn without crossing [[Edge]]s.
Since planar graphs don't cross [[Edge]]s they can be imagined as 3d [[Objects]].

Euler's [[Formula]] declares that for any connected planar graph
$\because$ planar graphs can be imagined as 3d, the [[Formula]] $Vertices + Faces - 2 = Edges$ can be applied
$\therefore Vertices-Edges+Faces=2$ can be applied to check if a graph is planar

![[planarGraph.excalidraw|250]]

The graph above has 8 faces, 6 [[Vertices]], and 12 edges
$$
\begin{aligned}
V - E + F &= 2 \\
6 - 12 + 8 &= 2 \\
2 &= 2
\end{aligned}
$$

## Flashcards

Define a complete graph::A graph where all [[Vertices]] are directly connected to each other ![[completeGraphs.excalidraw]]
<!--SR:!2026-10-11,62,310-->

Define a planar graph::A graph where no edges cross over ![[planarGraph.excalidraw]]
<!--SR:!2026-10-08,60,310-->
Describe a cycle graph::A graph where you place the [[Vertices]] in a circle and connect them according to the skip number ![[cycleGraph.excalidraw]]
<!--SR:!2027-06-12,249,330-->
Describe isomorphic graphs::Two graphs that have the same structural relationships ![[isomorphic.excalidraw]]
<!--SR:!2027-01-11,117,290-->

What is a degree within graph theory?::A degree is how many ways you can leave the vertex, for example in the image below the vertex has a degree of 2![[loopEdge.excalidraw]]
<!--SR:!2026-10-15,63,310-->


What is the Handshaking lemma and how is it useful or applied?::The Hand shaking lemma is claim that the total number of degrees within a graph is equal to the number of edges $\times$ 2, if this is not true for any graph than the graph is impossible
<!--SR:!2027-02-17,154,310-->
